"""Password-protected administration; secrets never appear in API responses."""
import hashlib
import hmac
import json
import os
import secrets
import shutil
import tempfile
import threading
import time
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from . import ai_analysis as ai

router = APIRouter(prefix='/api/admin')
COOKIE = 'ranging_admin'
SESSION_SECONDS = 8 * 3600
guard = threading.Lock()
sessions = {}
attempts = {}

def password_config():
    path = Path(os.environ.get('RANGING_ADMIN_CONFIG', ai.PROJECT/'config/admin.local.json'))
    try:
        data = json.loads(path.read_text('utf-8'))
        salt, digest = bytes.fromhex(data['salt']), bytes.fromhex(data['hash'])
        if len(salt) != 16 or len(digest) != 32: raise ValueError()
        return salt, digest
    except (OSError, ValueError, KeyError, TypeError):
        raise HTTPException(503, '管理密码尚未配置，请联系网站维护者。') from None

def origin_check(request: Request):
    origin = request.headers.get('origin')
    if origin and origin != f'{request.url.scheme}://{request.url.netloc}':
        raise HTTPException(403, '请从本站管理页面操作。')
    if request.headers.get('x-admin-action') != '1':
        raise HTTPException(403, '缺少管理操作校验。')

def authenticated(request: Request):
    token = request.cookies.get(COOKIE, '')
    key = hashlib.sha256(token.encode()).hexdigest()
    now = time.monotonic()
    with guard:
        for expired in [k for k,v in sessions.items() if v < now]: sessions.pop(expired)
        valid = bool(token) and sessions.get(key, 0) > now
    return valid

def require_admin(request: Request):
    if not authenticated(request): raise HTTPException(401, '请先登录管理页面。')
    if request.method not in ('GET', 'HEAD'): origin_check(request)

class Login(BaseModel):
    password: str = Field(min_length=1, max_length=128)

@router.post('/login')
def login(data: Login, request: Request, response: Response):
    origin_check(request)
    salt, expected = password_config()
    now = time.monotonic()
    ip = request.client.host if request.client else 'unknown'
    # Serialize verification with the counter, so concurrent attempts cannot evade it.
    with guard:
        for old in [k for k,v in attempts.items() if v[1] < now-900]: attempts.pop(old)
        count, started = attempts.get(ip, (0, now))
        if count >= 5: raise HTTPException(429, '尝试次数过多，请 15 分钟后重试。', headers={'Retry-After':'900'})
        actual = hashlib.scrypt(data.password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
        if not hmac.compare_digest(actual, expected):
            if len(attempts) >= 4096 and ip not in attempts: attempts.pop(next(iter(attempts)))
            attempts[ip] = (count+1, started)
            raise HTTPException(401, '管理密码不正确。')
        attempts.pop(ip, None)
        for expired in [k for k,v in sessions.items() if v < now]: sessions.pop(expired)
        if len(sessions) >= 256: sessions.pop(next(iter(sessions)))
        token = secrets.token_urlsafe(32)
        sessions[hashlib.sha256(token.encode()).hexdigest()] = now+SESSION_SECONDS
    response.set_cookie(COOKIE, token, httponly=True, secure=request.url.scheme=='https',
                        samesite='strict', max_age=SESSION_SECONDS, path='/api/admin')
    response.headers['Cache-Control'] = 'no-store'
    return {'authenticated': True}

@router.get('/session')
def session(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return {'authenticated': authenticated(request)}

@router.post('/logout', dependencies=[Depends(require_admin)])
def logout(request: Request, response: Response):
    with guard: sessions.pop(hashlib.sha256(request.cookies.get(COOKIE,'').encode()).hexdigest(), None)
    response.delete_cookie(COOKIE, path='/api/admin')
    return {'authenticated': False}

def config_view():
    value = ai.settings()
    result = value.model_dump(exclude={'api_key','api_key_env'})
    result.update(has_api_key=bool(value.api_key), key_from_environment=bool(os.environ.get(value.api_key_env)))
    return result

@router.get('/ai', dependencies=[Depends(require_admin)])
def read_config(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    try: return config_view()
    except ai.AIError as exc: raise HTTPException(422, str(exc)) from None

class AIConfig(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool
    base_url: str = Field(max_length=500)
    model: str = Field(min_length=1, max_length=100)
    api_key: str = Field(default='', max_length=4096)
    clear_api_key: bool = False
    thinking: str = Field(pattern='^(enabled|disabled)$')
    temperature: float = Field(ge=0, le=2, allow_inf_nan=False)
    max_tokens: int = Field(ge=256, le=32000)
    timeout_seconds: int = Field(ge=10, le=300)

@router.put('/ai', dependencies=[Depends(require_admin)])
def write_config(data: AIConfig):
    with guard:
        try: previous = ai.settings()
        except ai.AIError as exc: raise HTTPException(422, str(exc)) from None
        url = data.base_url.strip().rstrip('/')
        try: parsed = urlsplit(url)
        except ValueError: raise HTTPException(422, 'API 地址格式无效。') from None
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise HTTPException(422, 'API 地址必须为 HTTPS 基础地址，不含账号或查询参数。')
        new_key = data.api_key.strip()
        env_key = bool(os.environ.get(previous.api_key_env))
        if env_key and (new_key or data.clear_api_key or url != previous.base_url):
            raise HTTPException(409, '密钥由服务器环境变量管理，不能在网页更换密钥或 API 地址。')
        if new_key and data.clear_api_key: raise HTTPException(422, '不能同时填写和清除密钥。')
        if url != previous.base_url and previous.api_key and not (new_key or data.clear_api_key):
            raise HTTPException(422, '更换 API 地址时，请重新填写新服务的密钥，或勾选清除密钥。')
        path = Path(os.environ.get('RANGING_AI_CONFIG', ai.PROJECT/'config/ai.local.toml'))
        # Preserve the on-disk key rather than copying a secret from the environment.
        raw = ai.tomllib.loads(path.read_text('utf-8-sig')) if path.exists() else {}
        values = data.model_dump(exclude={'clear_api_key'})
        values['base_url'] = url
        values['api_key'] = '' if data.clear_api_key else new_key or raw.get('api_key','')
        values['api_key_env'] = previous.api_key_env
        if data.enabled and not (values['api_key'] or env_key): raise HTTPException(422, '启用 AI 前请填写 API Key。')
        content = '\n'.join(f'{k} = {str(v).lower() if isinstance(v,bool) else json.dumps(v,ensure_ascii=False)}' for k,v in values.items())+'\n'
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix='.ai-', suffix='.toml', dir=path.parent)
        try:
            with os.fdopen(fd,'w',encoding='utf-8',newline='\n') as out:
                out.write(content); out.flush(); os.fsync(out.fileno())
            os.chmod(name, 0o600)
            os.replace(name,path)
        finally:
            if os.path.exists(name): os.unlink(name)
        return config_view()

@router.get('/experiments', dependencies=[Depends(require_admin)])
def experiments():
    from . import main as m
    with m.database() as db:
        return [dict(r) for r in db.execute('SELECT id,name,created_at,status,notes,deleted_at,(SELECT count(*) FROM ai_runs WHERE experiment_id=experiments.id) AS ai_count FROM experiments ORDER BY created_at DESC')]

def idle(db, eid):
    row = db.execute('SELECT * FROM experiments WHERE id=?',(eid,)).fetchone()
    if not row: raise HTTPException(404, '实验不存在。')
    if row['status'] in ('queued','processing') or db.execute("SELECT 1 FROM ai_runs WHERE experiment_id=? AND status='running'",(eid,)).fetchone():
        raise HTTPException(409, '该实验正在解析或生成 AI 报告，请完成后再操作。')
    return row

@router.delete('/experiments/{eid}', dependencies=[Depends(require_admin)])
def trash(eid: str):
    from . import main as m
    with m.LOCK, m.database() as db:
        db.execute('BEGIN IMMEDIATE')
        row = idle(db,eid)
        if not row['deleted_at']:
            db.execute('UPDATE experiments SET deleted_at=? WHERE id=?',(datetime.now(timezone.utc).isoformat(),eid))
    m.loaded.cache_clear(); m.current_report.cache_clear()
    return {'status':'trashed'}

@router.post('/experiments/{eid}/restore', dependencies=[Depends(require_admin)])
def restore(eid: str):
    from . import main as m
    with m.LOCK, m.database() as db:
        db.execute('BEGIN IMMEDIATE')
        idle(db,eid)
        db.execute('UPDATE experiments SET deleted_at=NULL WHERE id=?',(eid,))
    return {'status':'restored'}

class Purge(BaseModel):
    confirm_name: str = Field(max_length=200)

@router.post('/experiments/{eid}/purge', dependencies=[Depends(require_admin)])
def purge(eid: str, data: Purge):
    from . import main as m
    import re
    if not re.fullmatch('[a-f0-9]{32}',eid): raise HTTPException(404,'实验不存在。')
    folder = m.ROOT/eid
    quarantine = m.ROOT/'.purging'/f'{eid}-{secrets.token_hex(8)}'
    moved = False
    with m.LOCK:
        try:
            with m.database() as db:
                db.execute('BEGIN IMMEDIATE')
                row = idle(db,eid)
                if not row['deleted_at']: raise HTTPException(409,'请先将实验移入回收站。')
                if data.confirm_name != row['name']: raise HTTPException(422,'输入的实验名称不一致。')
                if folder.is_symlink() or not folder.resolve().is_relative_to(m.ROOT): raise HTTPException(409,'数据目录异常，未删除。')
                if folder.exists():
                    quarantine.parent.mkdir(exist_ok=True)
                    if not quarantine.parent.resolve().is_relative_to(m.ROOT): raise HTTPException(409,'回收目录异常。')
                    folder.rename(quarantine); moved = True
                db.execute('DELETE FROM ai_runs WHERE experiment_id=?',(eid,))
                db.execute('DELETE FROM experiments WHERE id=?',(eid,))
        except BaseException:
            if moved: quarantine.rename(folder)
            raise
        m.loaded.cache_clear(); m.current_report.cache_clear()
        pending = False
        if moved:
            try: shutil.rmtree(quarantine)
            except OSError: pending = True
    return {'status':'purged', 'cleanup_pending':pending}
