import json
from pathlib import Path
import struct
import numpy as np
import pytest
from app.analysis import read_capture, build_report, waveform, alignment_segments, json_safe
from app.legacy_decoder import fnv1a, parse

def write_fixture(folder, broken=False):
    folder.mkdir(parents=True,exist_ok=True)
    lines=[]
    for board in 'AB':
        shift=1000000 if board=='B' else 0
        logs=(f'event,1,{1_001_000_000+shift},800,1\nclock,1,1001000000,0,{shift},0\n'
              f'candidate,1,0,10,20,30,800\n'
              f'event,2,{1_008_000_000+shift},810,1\nclock,2,1008000000,0,{shift},0\n')
        if board=='A': logs+='pair,87,429,1001000000,1001000000,1,0,1000,2000,640000,100000,20,30,1,1,2,1\n'
        logs=logs.encode('ascii')
        pcm=np.zeros((480,2),dtype='<i2');pcm[100,0]=30000;pcm[101,0]=-29000
        anchors=b''.join(struct.pack('<QQII',i*48,1_000_000_000+shift+i*1_000_000,1,48) for i in range(1,11))
        meta={'format':'RNG1','board':board,'rate':48000,'frames':480,'header_bytes':4096,'channels':2,'sample_bytes':2,'anchor_bytes':24,'anchor_count':10,'log_bytes':len(logs),'log_overflow':0,'temperature_deci_c':250,'session':2**63+7}
        raw=json.dumps(meta).encode().ljust(4096,b'\0')+pcm.tobytes()+anchors+logs
        (folder/f'{board}.RNG').write_bytes(raw)
        lines.append(f'{board} bytes={len(raw)} fnv1a={fnv1a(raw):08X}')
    (folder/'COMPLETE.TXT').write_text('RNG1 complete\n'+'\n'.join(lines),'ascii')
    if broken:
        raw=bytearray((folder/'A.RNG').read_bytes());raw[4096]^=1;(folder/'A.RNG').write_bytes(raw)
    return folder

def test_known_mapping_and_protocol_ids(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    report=build_report(boards)
    assert report['pairs'][0]['raw']['event_a_id']=='87'
    assert report['pairs'][0]['events']['A']['event']=='1'
    assert report['pairs'][0]['events']['B']['event']=='1'
    assert report['pairs'][0]['time_s']==pytest.approx(.001)
    assert report['stats']['mean_mm']==pytest.approx(.34645)
    assert report['stats']['accepted']==1
    assert json_safe(report)['boards']['A']['meta']['session']==str(2**63+7)

def test_checksum_failure(tmp_path):
    with pytest.raises(ValueError,match='校验值'):read_capture(write_fixture(tmp_path,True))

def test_missing_marker(tmp_path):
    with pytest.raises(FileNotFoundError):read_capture(tmp_path)

def test_wave_envelope_and_no_extrapolation(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    result=waveform(boards,0,.01,pixels=2)
    a,b=result['traces'][0],result['traces'][2]
    assert max(v for v in a['y'] if v is not None)==30000
    assert min(v for v in a['y'] if v is not None)==-29000
    assert min(v for v in b['x'] if v is not None)>=.001
    assert max(v for v in b['x'] if v is not None)<=.008
    for x,y in zip(a['x'],a['y']):
        if y==30000:assert x==pytest.approx(100/48000,abs=1e-9)

def test_unlock_and_epoch_break_alignment(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    assert len(alignment_segments(boards['B']))==1
    boards['B']['logs']['event'][1]['locked']='0'
    assert alignment_segments(boards['B'])==[]
    boards['B']['logs']['event'][1]['locked']='1'
    a=boards['B']['anchors'];boards['B']['anchors']=[(*r[:2],2,r[3]) if i>4 else r for i,r in enumerate(a)]
    assert alignment_segments(boards['B'])==[]

def test_legacy_equivalence(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    for b in 'AB':
        meta,pcm,anchors,logs=parse((tmp_path/f'{b}.RNG').read_bytes())
        assert meta==boards[b]['meta']
        assert pcm==boards[b]['pcm'].tobytes()
        assert anchors==boards[b]['anchors']
        assert len(logs)==sum(map(len,boards[b]['logs'].values()))

def test_duplicate_clock_does_not_guess(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    boards['A']['logs']['clock'].append(boards['A']['logs']['clock'][0].copy())
    report=build_report(boards)
    assert report['pairs'][0]['events']['A'] is None
    assert any('无法' in w for w in report['warnings'])
