import os
from pathlib import Path
import tempfile
import time
import io
import wave
from app.analysis import read_capture
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
        decoded=client.get(f'/api/experiments/{eid}/decoded/A?table=pcm&offset=100&limit=2')
        assert decoded.status_code==200
        assert decoded.json()['rows'][0]['ch1']=='30000'
        assert client.get(f'/api/experiments/{eid}/decoded/B?table=pair').json()['total']==0
        assert client.get(f'/api/experiments/{eid}/decoded/C').status_code==422
        assert client.get(f'/api/experiments/{eid}/decoded/A?table=unknown').status_code==422
        assert client.get(f'/api/experiments/{eid}/decoded/A?limit=501').status_code==422
        full_csv=client.get(f'/api/experiments/{eid}/decoded/A?table=pcm&format=csv&offset=100&limit=2')
        assert len(full_csv.text.splitlines())==481  # Export deliberately ignores pagination.
        captures,_=read_capture(folder)
        for board in 'AB':
            for channel in ('stereo','1','2'):
                url=f'/api/experiments/{eid}/audio/{board}.wav?channel={channel}'
                audio=client.get(url)
                assert audio.status_code==200
                assert audio.headers['content-type']=='audio/wav'
                with wave.open(io.BytesIO(audio.content),'rb') as wav:
                    assert wav.getnchannels()==(2 if channel=='stereo' else 1)
                    assert wav.getframerate()==48000 and wav.getsampwidth()==2 and wav.getnframes()==480
                    expected=captures[board]['pcm'] if channel=='stereo' else captures[board]['pcm'][:,int(channel)-1]
                    assert wav.readframes(480)==expected.tobytes()
                chunk=client.get(url,headers={'Range':'bytes=44-51'})
                assert chunk.status_code==206 and chunk.content==audio.content[44:52]
                assert 'attachment' in client.get(url+'&download=true').headers['content-disposition']
        assert client.get(f'/api/experiments/{eid}/audio/C.wav').status_code==422
        assert client.get(f'/api/experiments/{eid}/audio/A.wav?channel=3').status_code==422
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
        assert client.get(f'/api/experiments/{fail}/decoded/A').status_code==409
        assert client.get(f'/api/experiments/{fail}/audio/A.wav').status_code==409
