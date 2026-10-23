import csv
import io
import json
import os
import shutil
import sqlite3
import threading
import uuid
import tempfile
import wave as wave_io
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response, FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from .analysis import read_capture, build_report, json_safe, waveform
from .data_views import TABLES, table_page, csv_chunks
from . import ai_analysis as ai

ROOT=Path(os.environ.get('RANGING_DATA_DIR',Path(__file__).resolve().parents[2]/'data')).resolve()
ROOT.mkdir(parents=True,exist_ok=True)
DB=ROOT/'studio.sqlite3'
POOL=ThreadPoolExecutor(max_workers=1,thread_name_prefix='analysis')
AI_POOL=ThreadPoolExecutor(max_workers=1,thread_name_prefix='ai-analysis')
LIMIT=64*1024*1024
LOCK=threading.Lock()

@contextmanager
def database():
    con=sqlite3.connect(DB,timeout=30)
    con.row_factory=sqlite3.Row
    try:
        yield con
        con.commit()
    finally: con.close()

with database() as db:
    db.execute('''CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',truth_mm REAL,error TEXT,digest TEXT,summary TEXT)''')
    db.execute('''CREATE TABLE IF NOT EXISTS ai_runs (
        id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, created_at TEXT NOT NULL,
        status TEXT NOT NULL, preset TEXT NOT NULL, focus TEXT NOT NULL, model TEXT NOT NULL,
        base_url TEXT NOT NULL, source_hash TEXT NOT NULL, snapshot TEXT NOT NULL,
        result TEXT, error TEXT)''')

@asynccontextmanager
async def lifespan(app):
    global AI_POOL
    AI_POOL=ThreadPoolExecutor(max_workers=1,thread_name_prefix='ai-analysis')
    with database() as db:
        db.execute("UPDATE experiments SET status='failed',error='服务重启中断了分析，请重试' WHERE status IN ('queued','processing')")
        db.execute("UPDATE ai_runs SET status='failed',error='服务重启中断了 AI 分析，请手动重新生成。' WHERE status='running'")
    yield
    POOL.shutdown(wait=True)
    AI_POOL.shutdown(wait=True)

app=FastAPI(title='Ranging Studio',version='0.1.0',lifespan=lifespan)

def row_by_id(experiment_id):
    with database() as db: row=db.execute('SELECT * FROM experiments WHERE id=?',(experiment_id,)).fetchone()
    if not row: raise HTTPException(404,'实验不存在')
    return dict(row)

def public_row(row):
    r=dict(row)
    r['summary']=json.loads(r['summary']) if r.get('summary') else None
    return r

def process(experiment_id):
    folder=ROOT/experiment_id
    try:
        with database() as db: db.execute("UPDATE experiments SET status='processing',error=NULL WHERE id=?",(experiment_id,))
        boards,digest=read_capture(folder/'raw')
        report=json_safe(build_report(boards))
        (folder/'report.json').write_text(json.dumps(report,ensure_ascii=False,allow_nan=False),encoding='utf-8')
        with database() as db:
            db.execute("UPDATE experiments SET status='ready',digest=?,summary=? WHERE id=?",(digest,json.dumps(report['stats']),experiment_id))
    except Exception as exc:
        with database() as db: db.execute("UPDATE experiments SET status='failed',error=? WHERE id=?",(f'{type(exc).__name__}: {exc}',experiment_id))

@lru_cache(maxsize=2)
def loaded(experiment_id):
    return read_capture(ROOT/experiment_id/'raw')[0]

@app.get('/api/health')
def health(): return {'status':'ok','version':'0.1.0','mode':'local'}

@app.get('/api/experiments')
def listing():
    with database() as db: rows=db.execute('SELECT * FROM experiments ORDER BY created_at DESC').fetchall()
    return [public_row(r) for r in rows]

@app.post('/api/experiments',status_code=202)
async def upload(files:Annotated[list[UploadFile],File()], name:Annotated[str,Form()]= '未命名实验',
                 notes:Annotated[str,Form()]='', truth_mm:Annotated[str,Form()]=''):
    if len(name)>200 or len(notes)>4000: raise HTTPException(422,'名称或备注过长')
    truth=None
    if truth_mm:
        try: truth=float(truth_mm)
        except ValueError: raise HTTPException(422,'真实距离必须是数值')
        if not 0 <= truth <= 100000: raise HTTPException(422,'真实距离须在 0—100000 mm 内')
    expected={'A.RNG','B.RNG','COMPLETE.TXT'}
    # Names are matched, never used as arbitrary filesystem paths.
    if len(files)!=3 or {f.filename for f in files}!=expected:
        raise HTTPException(422,'请选择 A.RNG、B.RNG、COMPLETE.TXT 三个文件，不含子路径')
    experiment_id=uuid.uuid4().hex
    folder=ROOT/experiment_id/'raw'; folder.mkdir(parents=True)
    total=0
    try:
        for file in files:
            with (folder/file.filename).open('wb') as output:
                while chunk:=await file.read(1024*1024):
                    total+=len(chunk)
                    if total>LIMIT: raise HTTPException(413,'单轮上传上限为 64 MiB')
                    output.write(chunk)
        with database() as db:
            db.execute('INSERT INTO experiments (id,name,created_at,status,notes,truth_mm) VALUES (?,?,?,?,?,?)',
                (experiment_id,name.strip() or '未命名实验',datetime.now(timezone.utc).isoformat(),'queued',notes,truth))
        POOL.submit(process,experiment_id)
    except Exception:
        shutil.rmtree(folder.parent)
        raise
    finally:
        for file in files: await file.close()
    return public_row(row_by_id(experiment_id))

@app.get('/api/experiments/{experiment_id}')
def detail(experiment_id:str):
    row=public_row(row_by_id(experiment_id))
    if row['status']=='ready':
        row['report']=json.loads((ROOT/experiment_id/'report.json').read_text('utf-8'))
        with database() as db:
            row['duplicate_count']=db.execute('SELECT COUNT(*) FROM experiments WHERE digest=? AND id<>?',(row['digest'],experiment_id)).fetchone()[0]
    return row

class Metadata(BaseModel):
    name:str=Field(min_length=1,max_length=200)
    notes:str=Field(default='',max_length=4000)
    truth_mm:float|None=Field(default=None,ge=0,le=100000)

@app.patch('/api/experiments/{experiment_id}')
def edit(experiment_id:str, data:Metadata):
    row_by_id(experiment_id)
    with database() as db: db.execute('UPDATE experiments SET name=?,notes=?,truth_mm=? WHERE id=?',(data.name,data.notes,data.truth_mm,experiment_id))
    return public_row(row_by_id(experiment_id))

@app.post('/api/experiments/{experiment_id}/retry',status_code=202)
def retry(experiment_id:str):
    with LOCK:
        row=row_by_id(experiment_id)
        if row['status']!='failed': raise HTTPException(409,'仅失败任务可重试')
        with database() as db: db.execute("UPDATE experiments SET status='queued',error=NULL WHERE id=?",(experiment_id,))
        POOL.submit(process,experiment_id)
    return {'status':'queued'}

@app.get('/api/experiments/{experiment_id}/waveform')
def wave(experiment_id:str, start:float=Query(0,ge=0,allow_inf_nan=False), end:float=Query(16,gt=0,allow_inf_nan=False),
         pixels:int=Query(900,ge=100,le=2000),mode:str=Query('master',pattern='^(master|local)$')):
    if row_by_id(experiment_id)['status']!='ready': raise HTTPException(409,'实验尚未完成分析')
    if end<=start: raise HTTPException(422,'时间范围无效')
    return waveform(loaded(experiment_id),start,end,pixels,mode)

@app.get('/api/experiments/{experiment_id}/pairs.csv')
def export(experiment_id:str):
    result=detail(experiment_id)
    if 'report' not in result: raise HTTPException(409,'实验尚未完成分析')
    out=io.StringIO(newline='');writer=csv.writer(out)
    writer.writerow(['analysis_version','index','relative_master_s','outcome','delay_us','derived_distance_mm','temperature_c','bias_assumed_ns','a_protocol_id','b_protocol_id','a_local_event','b_local_event','reason'])
    for p in result['report']['pairs']:
        writer.writerow([result['report']['analysis_version'],p['index'],p['time_s'],p['outcome'],p['delay_us'],p['distance_mm'],result['report']['stats']['temperature_c'],0,
                         p['raw']['event_a_id'],p['raw']['event_b_id'],(p['events']['A'] or {}).get('event'),(p['events']['B'] or {}).get('event'),p['reason_label']])
    return Response('\ufeff'+out.getvalue(),media_type='text/csv; charset=utf-8',headers={'Content-Disposition':f'attachment; filename="{experiment_id}-pairs.csv"'})

def ready_boards(experiment_id):
    if row_by_id(experiment_id)['status']!='ready': raise HTTPException(409,'实验尚未完成分析')
    return loaded(experiment_id)

@app.get('/api/experiments/{experiment_id}/decoded/{board}')
def decoded(experiment_id:str, board:Literal['A','B'], table:str='metadata',
            offset:int=Query(0,ge=0), limit:int=Query(50,ge=1,le=500),
            format:Literal['json','csv']='json'):
    if table not in TABLES:raise HTTPException(422,'不支持的数据分类')
    capture=ready_boards(experiment_id)[board]
    if format=='csv':
        return StreamingResponse(csv_chunks(capture,table),media_type='text/csv; charset=utf-8',
            headers={'Content-Disposition':f'attachment; filename="{board}-{table}.csv"'})
    return table_page(capture,table,offset,limit)

@app.get('/api/experiments/{experiment_id}/audio/{board}.wav')
def audio(experiment_id:str, board:Literal['A','B'], channel:Literal['stereo','1','2']='stereo',download:bool=False):
    capture=ready_boards(experiment_id)[board]
    folder=ROOT/experiment_id/'audio';folder.mkdir(exist_ok=True)
    path=folder/f'{board}-{channel}.wav'
    if not path.is_file():
        # A unique temporary file and atomic replacement allow concurrent media requests.
        descriptor,temporary=tempfile.mkstemp(suffix='.wav',dir=folder)
        os.close(descriptor)
        try:
            pcm=capture['pcm'] if channel=='stereo' else capture['pcm'][:,int(channel)-1]
            with wave_io.open(temporary,'wb') as output:
                output.setnchannels(2 if channel=='stereo' else 1)
                output.setsampwidth(2)
                output.setframerate(capture['meta']['rate'])
                output.writeframes(pcm.tobytes())
            os.replace(temporary,path)
        finally:
            if os.path.isfile(temporary):os.unlink(temporary)
    return FileResponse(path,media_type='audio/wav',filename=path.name,
                        content_disposition_type='attachment' if download else 'inline')

class AIRequest(BaseModel):
    preset: Literal['summary','diagnosis','report']='summary'
    focus: str=Field(default='',max_length=2000)

class AIGenerateRequest(AIRequest):
    input_hash: str=Field(pattern=r'^[0-9a-f]{64}$')

def ai_input(experiment_id, data):
    experiment=detail(experiment_id)
    if 'report' not in experiment: raise HTTPException(409,'实验尚未完成分析')
    try:return ai.prepare(experiment,data.preset,data.focus)
    except ai.AIError as exc:raise HTTPException(422,str(exc)) from None

@app.get('/api/ai/config')
def ai_config():return ai.public_settings()

@app.post('/api/experiments/{experiment_id}/ai/preview')
def ai_preview(experiment_id:str,data:AIRequest):
    return ai_input(experiment_id,data)

def process_ai(run_id, config, snapshot):
    try:
        result=ai.complete(config,snapshot['messages'])
        with database() as db:
            db.execute("UPDATE ai_runs SET status='completed',result=? WHERE id=?",(ai.encode(result),run_id))
    except Exception as exc:
        message=str(exc) if isinstance(exc,ai.AIError) else 'AI 分析未完成，请检查本地服务配置后手动重试。'
        with database() as db:
            db.execute("UPDATE ai_runs SET status='failed',error=? WHERE id=?",(message,run_id))

@app.get('/api/experiments/{experiment_id}/ai/runs')
def ai_runs(experiment_id:str):
    experiment=detail(experiment_id)
    current=ai.fingerprint(experiment) if 'report' in experiment else None
    with database() as db:
        rows=db.execute('SELECT * FROM ai_runs WHERE experiment_id=? ORDER BY created_at DESC LIMIT 30',(experiment_id,)).fetchall()
    result=[]
    for row in rows:
        item=dict(row)
        item.pop('snapshot')
        item['result']=json.loads(item['result']) if item['result'] else None
        item['stale']=item['source_hash']!=current
        result.append(item)
    return result

@app.get('/api/experiments/{experiment_id}/ai/runs/{run_id}/snapshot')
def ai_snapshot(experiment_id:str,run_id:str):
    row_by_id(experiment_id)
    with database() as db:
        row=db.execute('SELECT snapshot FROM ai_runs WHERE id=? AND experiment_id=?',(run_id,experiment_id)).fetchone()
    if not row:raise HTTPException(404,'AI 分析记录不存在')
    return json.loads(row['snapshot'])

@app.post('/api/experiments/{experiment_id}/ai/runs',status_code=202)
def ai_generate(experiment_id:str,data:AIGenerateRequest):
    snapshot=ai_input(experiment_id,data)
    if snapshot['input_hash']!=data.input_hash:
        raise HTTPException(409,'数据或提示词已更新，请刷新分析材料后重新生成。')
    try:config=ai.settings(require_ready=True)
    except ai.AIError as exc:raise HTTPException(409,str(exc)) from None
    snapshot['request_parameters']={k:getattr(config,k) for k in ('base_url','model','max_tokens','temperature','thinking','timeout_seconds')}
    run_id=uuid.uuid4().hex
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute("SELECT 1 FROM ai_runs WHERE status='running' LIMIT 1").fetchone():
            raise HTTPException(409,'已有 AI 分析正在运行，请等待完成后再提交。')
        db.execute('INSERT INTO ai_runs (id,experiment_id,created_at,status,preset,focus,model,base_url,source_hash,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?)',
                   (run_id,experiment_id,datetime.now(timezone.utc).isoformat(),'running',data.preset,data.focus,config.model,config.base_url,snapshot['source_hash'],ai.encode(snapshot)))
    try:AI_POOL.submit(process_ai,run_id,config,snapshot)
    except RuntimeError:
        with database() as db:db.execute("UPDATE ai_runs SET status='failed',error='服务正在关闭，请重新启动后再试。' WHERE id=?",(run_id,))
        raise HTTPException(503,'服务正在关闭，请重新启动后再试。') from None
    return {'id':run_id,'status':'running'}

# Built frontend and API share one origin for the local launcher.
STATIC=Path(__file__).resolve().parents[2]/'frontend'/'dist'
if STATIC.is_dir(): app.mount('/',StaticFiles(directory=STATIC,html=True),name='frontend')
