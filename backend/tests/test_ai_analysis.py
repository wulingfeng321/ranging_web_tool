import json
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi.testclient import TestClient
from app import ai_analysis as ai
from app.analysis import read_capture, build_report, json_safe
from test_analysis import write_fixture


def experiment(tmp_path):
    boards,digest=read_capture(write_fixture(tmp_path/'raw'))
    return {'name':'fixture','notes':'仅用于测试','truth_mm':500.0,'digest':digest,
            'report':json_safe(build_report(boards))}


def test_context_uses_full_statistics_and_preserves_semantics(tmp_path):
    exp=experiment(tmp_path)
    data=ai.context(exp)
    ds=[p['distance_mm'] for p in exp['report']['pairs'] if p['outcome']==1 and p['distance_mm'] is not None]
    assert data['truth_metrics']['n']==len(ds)
    assert data['truth_metrics']['bias_mm']==pytest.approx(sum(ds)/len(ds)-500)
    assert data['truth_metrics']['mae_mm']==pytest.approx(sum(abs(d-500) for d in ds)/len(ds))
    assert data['pairs']['rows'][0]['raw']==exp['report']['pairs'][0]['raw']
    assert 'session' not in data['boards']['A']['meta']
    assert 'pcm' not in data['boards']['A']
    exp['truth_mm']=None
    assert ai.context(exp)['truth_metrics'] is None
    exp['report']['pairs']=[]
    assert ai.context(exp)['truth_metrics'] is None
    rows=[{'counter':str(2**63+i)} for i in range(200)]
    sampled=ai.sample(rows,40)
    assert sampled['total']==200 and sampled['included']==40
    assert sampled['rows'][0]==rows[0] and sampled['rows'][-1]==rows[-1]
    assert ai.numeric_summary(rows)['counter']['max']==str(2**63+199)
    assert 'sum' not in ai.numeric_summary(rows)['counter']


def test_prompts_and_fingerprints_change_with_input(tmp_path):
    exp=experiment(tmp_path)
    first=ai.prepare(exp,'summary','')
    assert '不是测距通过数' in first['messages'][0]['content']
    assert first['input_hash']!=ai.prepare(exp,'diagnosis','')['input_hash']
    assert first['input_hash']!=ai.prepare(exp,'summary','检查误差')['input_hash']
    exp['truth_mm']=600
    assert first['source_hash']!=ai.fingerprint(exp)
    with pytest.raises(ai.AIError):ai.prepare(exp,'../../bad','')


def test_configuration_never_exposes_key(monkeypatch,tmp_path):
    path=tmp_path/'ai.toml'
    monkeypatch.setenv('RANGING_AI_CONFIG',str(path))
    monkeypatch.delenv('DEEPSEEK_API_KEY',raising=False)
    assert ai.public_settings()['ready'] is False
    path.write_text('enabled = true\napi_key = "secret-test"',encoding='utf-8')
    assert ai.settings(True).api_key=='secret-test'
    assert 'secret-test' not in json.dumps(ai.public_settings())
    monkeypatch.setenv('DEEPSEEK_API_KEY','env-secret')
    assert ai.settings(True).api_key=='env-secret'
    for invalid in ['api_key = "secret-test"\ntimeout_seconds = 0', 'api_key = "secret-test', 'base_url = "http://example.com"']:
        path.write_text(invalid,encoding='utf-8')
        assert ai.public_settings()['ready'] is False
        assert 'secret-test' not in json.dumps(ai.public_settings())


def mock_client(monkeypatch, handler):
    original=httpx.Client
    monkeypatch.setattr(ai.httpx,'Client',lambda **kw:original(transport=httpx.MockTransport(handler),**kw))


def test_provider_request_and_partial_output(monkeypatch):
    def respond(request):
        body=json.loads(request.content)
        assert str(request.url)=='https://api.deepseek.com/chat/completions'
        assert request.headers['authorization']=='Bearer test-only'
        assert body['model']=='deepseek-flash' and body['stream'] is False
        assert body['thinking']=={'type':'disabled'} and body['max_tokens']==6000
        return httpx.Response(200,json={'choices':[{'message':{'content':'## 报告\n测试结论'},'finish_reason':'length'}],
                                       'usage':{'prompt_tokens':123,'completion_tokens':45,'secret':'hidden'}})
    mock_client(monkeypatch,respond)
    result=ai.complete(ai.Settings(api_key='test-only'),[{'role':'user','content':'test'}])
    assert result['content'].startswith('## 报告') and result['finish_reason']=='length'
    assert result['usage']=={'prompt_tokens':123,'completion_tokens':45}


@pytest.mark.parametrize('status',[401,402,404,429,500,302])
def test_provider_errors_do_not_leak_response_or_retry(monkeypatch,status):
    calls=[]
    def respond(request):
        calls.append(request)
        return httpx.Response(status,text='secret-test provider internal details')
    mock_client(monkeypatch,respond)
    with pytest.raises(ai.AIError) as err:ai.complete(ai.Settings(api_key='secret-test'),[])
    assert 'secret-test' not in str(err.value) and len(calls)==1


@pytest.mark.parametrize('body',[{}, {'choices':[]}, {'choices':[{'message':{'content':None}}]}, ['invalid']])
def test_malformed_provider_response(monkeypatch,body):
    mock_client(monkeypatch,lambda request:httpx.Response(200,json=body))
    with pytest.raises(ai.AIError):ai.complete(ai.Settings(),[])


def test_provider_timeout(monkeypatch):
    def respond(request):raise httpx.ReadTimeout('secret url',request=request)
    mock_client(monkeypatch,respond)
    with pytest.raises(ai.AIError,match='未自动重试'):ai.complete(ai.Settings(),[])


def test_ai_api_history_concurrency_failure_and_snapshot(monkeypatch,tmp_path):
    from app import main
    # Isolated DB and report; no uploads or real provider requests.
    with main.database() as db:
        schemas=[r[0] for r in db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('experiments','ai_runs')")]
    monkeypatch.setattr(main,'ROOT',tmp_path)
    monkeypatch.setattr(main,'DB',tmp_path/'test.sqlite3')
    pool=ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(main,'AI_POOL',pool)
    exp=experiment(tmp_path/'source')
    folder=tmp_path/'sample';folder.mkdir()
    (folder/'report.json').write_text(json.dumps(exp['report']),encoding='utf-8')
    with main.database() as db:
        for schema in schemas:db.execute(schema)
        db.execute('INSERT INTO experiments(id,name,created_at,status,notes,truth_mm,digest) VALUES(?,?,?,?,?,?,?)',
                   ('sample',exp['name'],'2026-10-24','ready',exp['notes'],exp['truth_mm'],exp['digest']))
    config=tmp_path/'ai.toml'
    config.write_text('enabled = false',encoding='utf-8')
    monkeypatch.setenv('RANGING_AI_CONFIG',str(config))
    monkeypatch.delenv('DEEPSEEK_API_KEY',raising=False)
    started=threading.Event(); release=threading.Event()
    def complete(settings,messages):
        started.set();release.wait(5)
        return {'content':'模拟 API 测试报告','usage':{'total_tokens':10},'finish_reason':'stop'}
    monkeypatch.setattr(ai,'complete',complete)
    client=TestClient(main.app)
    try:
        url='/api/experiments/sample/ai'
        preview=client.post(url+'/preview',json={'preset':'summary'}).json()
        assert 'input_hash' in preview
        body={'preset':'summary','input_hash':preview['input_hash']}
        assert client.post(url+'/runs',json=body).status_code==409
        config.write_text('enabled = true\napi_key = "secret-only-test"',encoding='utf-8')
        response=client.post(url+'/runs',json=body)
        assert response.status_code==202,response.text
        rid=response.json()['id'];assert started.wait(2)
        assert client.post(url+'/runs',json=body).status_code==409
        release.set()
        for _ in range(100):
            runs=client.get(url+'/runs').json()
            if runs[0]['status']!='running':break
            time.sleep(.01)
        assert runs[0]['status']=='completed'
        assert runs[0]['result']['content']=='模拟 API 测试报告'
        snapshot=client.get(url+f'/runs/{rid}/snapshot').json()
        assert snapshot['messages']==preview['messages']
        assert 'secret-only-test' not in json.dumps([runs,snapshot,client.get('/api/ai/config').json()])
        assert client.get(url+'/runs/no-such-run/snapshot').status_code==404
        client.patch('/api/experiments/sample',json={'name':'changed','truth_mm':600})
        assert client.get(url+'/runs').json()[0]['stale'] is True
        assert client.post(url+'/runs',json=body).status_code==409
        def fail(*args):raise ai.AIError('账户余额不足。')
        monkeypatch.setattr(ai,'complete',fail)
        body['input_hash']=client.post(url+'/preview',json={'preset':'summary'}).json()['input_hash']
        assert client.post(url+'/runs',json=body).status_code==202
        for _ in range(100):
            runs=client.get(url+'/runs').json()
            if runs[0]['status']!='running':break
            time.sleep(.01)
        assert runs[0]['status']=='failed' and runs[0]['error']=='账户余额不足。'
        assert client.post(url+'/preview',json={'preset':'unknown'}).status_code==422
        assert client.post(url+'/preview',json={'focus':'x'*2001}).status_code==422
        assert client.post('/api/experiments/missing/ai/preview',json={}).status_code==404
    finally:
        release.set();pool.shutdown(wait=True);client.close()
