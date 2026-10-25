import hashlib
import json
import os
import sqlite3
import tempfile
import time

os.environ.setdefault('RANGING_DATA_DIR', tempfile.mkdtemp(prefix='ranging-admin-suite-'))
import pytest
from fastapi.testclient import TestClient
from app import main as m, admin, ai_analysis as ai
from test_analysis import write_fixture

HEADERS = {'X-Admin-Action':'1'}

@pytest.fixture
def client(tmp_path, monkeypatch):
    root=tmp_path/'data'; root.mkdir()
    newdb=root/'studio.sqlite3'
    with sqlite3.connect(m.DB) as src, sqlite3.connect(newdb) as dst:
        for sql, in src.execute("SELECT sql FROM sqlite_master WHERE type='table'"):
            dst.execute(sql)
    monkeypatch.setattr(m,'ROOT',root); monkeypatch.setattr(m,'DB',newdb)
    cfg=tmp_path/'ai.toml'; cfg.write_text('enabled = false\napi_key = "private-key-never-return"\n')
    pwd=tmp_path/'admin.json'; salt=b'0123456789abcdef'
    pwd.write_text(json.dumps({'salt':salt.hex(),'hash':hashlib.scrypt(b'qa-password',salt=salt,n=16384,r=8,p=1,dklen=32).hex()}))
    monkeypatch.setenv('RANGING_AI_CONFIG',str(cfg)); monkeypatch.setenv('RANGING_ADMIN_CONFIG',str(pwd))
    monkeypatch.delenv('DEEPSEEK_API_KEY',raising=False)
    admin.sessions.clear(); admin.attempts.clear(); m.loaded.cache_clear(); m.current_report.cache_clear()
    with TestClient(m.app) as c: yield c
    admin.sessions.clear(); admin.attempts.clear(); m.loaded.cache_clear(); m.current_report.cache_clear()

def login(c):
    response=c.post('/api/admin/login',json={'password':'qa-password'},headers=HEADERS)
    assert response.status_code==200
    return response

def config_payload(c):
    value=c.get('/api/admin/ai').json()
    value.pop('has_api_key'); value.pop('key_from_environment')
    return value

def upload(c):
    folder=write_fixture(m.ROOT/'fixture-source')
    response=c.post('/api/experiments',files=[('files',(name,(folder/name).read_bytes())) for name in ('A.RNG','B.RNG','COMPLETE.TXT')],data={'name':'QA experiment'})
    assert response.status_code==202
    eid=response.json()['id']
    for _ in range(100):
        if c.get(f'/api/experiments/{eid}').json()['status']=='ready': return eid
        time.sleep(.02)
    pytest.fail('Analysis did not finish')

def test_auth_csrf_logout_and_validation_redaction(client):
    for path in ('/ai','/experiments'):
        assert client.get('/api/admin'+path).status_code==401
    assert client.put('/api/admin/ai',json={}).status_code==401
    assert client.delete('/api/admin/experiments/anything').status_code==401
    assert client.post('/api/admin/login',json={'password':'qa-password'}).status_code==403
    assert client.post('/api/admin/login',json={'password':'qa-password'},headers={**HEADERS,'Origin':'https://foreign.example'}).status_code==403
    response=login(client)
    assert 'HttpOnly' in response.headers['set-cookie'] and 'SameSite=strict' in response.headers['set-cookie']
    assert client.get('/api/admin/session').json()['authenticated']
    assert client.get('/api/admin/ai').headers['cache-control']=='no-store'
    response=client.put('/api/admin/ai',json={'api_key':'do-not-echo-this'},headers=HEADERS)
    assert response.status_code==422 and 'do-not-echo-this' not in response.text
    assert client.post('/api/admin/logout',headers=HEADERS).status_code==200
    assert client.get('/api/admin/ai').status_code==401

def test_login_throttles_and_session_expires(client, monkeypatch):
    for _ in range(5): assert client.post('/api/admin/login',json={'password':'wrong'},headers=HEADERS).status_code==401
    assert client.post('/api/admin/login',json={'password':'qa-password'},headers=HEADERS).status_code==429
    admin.attempts.clear(); login(client)
    monkeypatch.setattr(admin.time,'monotonic',lambda:10**12)
    assert client.get('/api/admin/ai').status_code==401

def test_https_cookie_and_no_default_admin_password(client):
    with TestClient(m.app,base_url='https://testserver') as secure:
        assert 'Secure' in login(secure).headers['set-cookie']
    from pathlib import Path
    Path(os.environ['RANGING_ADMIN_CONFIG']).unlink()
    assert client.post('/api/admin/login',json={'password':'anything'},headers=HEADERS).status_code==503

def test_ai_save_preserves_masks_and_clears_key(client):
    login(client)
    initial=client.get('/api/admin/ai')
    assert 'private-key-never-return' not in initial.text and initial.json()['has_api_key']
    data=config_payload(client); data.update(thinking='enabled',max_tokens=9000,temperature=.7,timeout_seconds=180)
    saved=client.put('/api/admin/ai',json=data,headers=HEADERS)
    assert saved.status_code==200 and 'private-key-never-return' not in saved.text
    assert ai.settings().api_key=='private-key-never-return'
    assert ai.settings().thinking=='enabled' and ai.settings().max_tokens==9000
    data['api_key']='replacement-key'
    saved=client.put('/api/admin/ai',json=data,headers=HEADERS)
    assert saved.status_code==200 and 'replacement-key' not in saved.text
    assert ai.settings().api_key=='replacement-key'
    data.update(api_key='',clear_api_key=True)
    assert client.put('/api/admin/ai',json=data,headers=HEADERS).status_code==200
    assert not ai.settings().api_key
    data['enabled']=True
    assert client.put('/api/admin/ai',json=data,headers=HEADERS).status_code==422

def test_ai_endpoint_change_and_env_keys(client,monkeypatch):
    login(client); data=config_payload(client)
    data['base_url']='https://other.example'
    assert client.put('/api/admin/ai',json=data,headers=HEADERS).status_code==422
    assert ai.settings().base_url=='https://api.deepseek.com'
    data.update(api_key='new-endpoint-key')
    assert client.put('/api/admin/ai',json=data,headers=HEADERS).status_code==200
    data['base_url']='http://other.example'
    assert client.put('/api/admin/ai',json=data,headers=HEADERS).status_code==422
    monkeypatch.setenv('DEEPSEEK_API_KEY','environment-secret')
    data=config_payload(client); data.update(api_key='replacement')
    assert client.put('/api/admin/ai',json=data,headers=HEADERS).status_code==409
    data['api_key']=''; data['thinking']='disabled'
    response=client.put('/api/admin/ai',json=data,headers=HEADERS)
    assert response.status_code==200 and 'environment-secret' not in response.text
    assert 'environment-secret' not in open(os.environ['RANGING_AI_CONFIG']).read()

def test_trash_restore_and_purge_all_associated_data(client):
    login(client); eid=upload(client)
    client.get(f'/api/experiments/{eid}/audio/A.wav')
    with m.database() as db:
        db.execute("INSERT INTO ai_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",('qa-run',eid,'now','completed','summary','','model','https://api.deepseek.com','hash','{}','{}',None))
    assert client.delete(f'/api/admin/experiments/{eid}',headers=HEADERS).status_code==200
    assert client.get('/api/experiments').json()==[]
    for suffix in ('','/waveform','/pairs.csv','/audio/A.wav','/ai/runs'):
        assert client.get(f'/api/experiments/{eid}'+suffix).status_code==404
    assert (m.ROOT/eid/'raw/A.RNG').exists()
    assert client.post(f'/api/admin/experiments/{eid}/restore',headers=HEADERS).status_code==200
    assert client.get(f'/api/experiments/{eid}').status_code==200
    assert len(client.get(f'/api/experiments/{eid}/ai/runs').json())==1
    assert client.post(f'/api/admin/experiments/{eid}/purge',json={'confirm_name':'QA experiment'},headers=HEADERS).status_code==409
    client.delete(f'/api/admin/experiments/{eid}',headers=HEADERS)
    assert client.post(f'/api/admin/experiments/{eid}/purge',json={'confirm_name':'wrong'},headers=HEADERS).status_code==422
    result=client.post(f'/api/admin/experiments/{eid}/purge',json={'confirm_name':'QA experiment'},headers=HEADERS)
    assert result.status_code==200 and not result.json()['cleanup_pending']
    assert not (m.ROOT/eid).exists()
    with m.database() as db:
        assert db.execute('SELECT count(*) FROM ai_runs').fetchone()[0]==0

def test_busy_experiment_cannot_be_deleted(client):
    login(client); eid=upload(client)
    with m.database() as db: db.execute("UPDATE experiments SET status='processing' WHERE id=?",(eid,))
    assert client.delete(f'/api/admin/experiments/{eid}',headers=HEADERS).status_code==409
    with m.database() as db:
        db.execute("UPDATE experiments SET status='ready' WHERE id=?",(eid,))
        db.execute("INSERT INTO ai_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",('qa-run',eid,'now','running','summary','','model','https://api.deepseek.com','hash','{}',None,None))
    assert client.delete(f'/api/admin/experiments/{eid}',headers=HEADERS).status_code==409

def test_purge_rename_failure_rolls_back_database(client,monkeypatch):
    from pathlib import Path
    login(client); eid=upload(client)
    client.delete(f'/api/admin/experiments/{eid}',headers=HEADERS)
    def fail(*args): raise PermissionError('cannot rename')
    monkeypatch.setattr(Path,'rename',fail)
    with pytest.raises(PermissionError):
        client.post(f'/api/admin/experiments/{eid}/purge',json={'confirm_name':'QA experiment'},headers=HEADERS)
    with m.database() as db: assert db.execute('SELECT count(*) FROM experiments WHERE id=?',(eid,)).fetchone()[0]==1
    assert (m.ROOT/eid).exists()
