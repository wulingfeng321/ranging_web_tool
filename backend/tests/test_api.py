import os
from pathlib import Path
import tempfile
import time
os.environ['RANGING_DATA_DIR']=tempfile.mkdtemp(prefix='ranging-api-test-')
from fastapi.testclient import TestClient
from app.main import app
from test_analysis import write_fixture

def test_upload_inspect_update_export_and_rejection(tmp_path):
    folder=write_fixture(tmp_path/'source')
    def files():return [('files',(name,(folder/name).read_bytes(),'application/octet-stream')) for name in ['A.RNG','B.RNG','COMPLETE.TXT']]
    with TestClient(app) as client:
        assert client.get('/api/health').status_code==200
        bad=client.post('/api/experiments',files=[('files',('../A.RNG',b'bad'))])
        assert bad.status_code==422
        assert client.post('/api/experiments',files=files(),data={'truth_mm':'nan'}).status_code==422
        response=client.post('/api/experiments',files=files(),data={'name':'测试实验'})
        assert response.status_code==202,response.text
        eid=response.json()['id']
        for _ in range(100):
            data=client.get(f'/api/experiments/{eid}').json()
            if data['status'] not in ('queued','processing'):break
            time.sleep(.02)
        assert data['status']=='ready',data
        assert data['report']['pairs'][0]['events']['A']['event']=='1'
        assert client.get(f'/api/experiments/{eid}/waveform?start=0&end=0.01').status_code==200
        assert client.get(f'/api/experiments/{eid}/waveform?start=1&end=0.01').status_code==422
        assert client.patch(f'/api/experiments/{eid}',json={'name':'已修改','truth_mm':500,'notes':'test'}).status_code==200
        assert client.get(f'/api/experiments/{eid}/pairs.csv').text.startswith('\ufeffanalysis_version')
        assert client.get('/api/experiments/not-found').status_code==404
        write_fixture(folder,broken=True)
        fail=client.post('/api/experiments',files=files()).json()['id']
        for _ in range(100):
            data=client.get(f'/api/experiments/{fail}').json()
            if data['status']=='failed':break
            time.sleep(.02)
        assert data['status']=='failed'
        assert '校验值' in data['error']
        assert client.get(f'/api/experiments/{fail}/waveform').status_code==409
