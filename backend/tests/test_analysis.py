import json
from pathlib import Path
import struct
import numpy as np
import pytest
from app.analysis import read_capture, build_report, waveform, alignment_segments, waveform_alignment_segments, json_safe
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

def test_wave_envelope_and_event_model_margins(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    result=waveform(boards,0,.01,pixels=2)
    a,b=result['traces'][0],result['traces'][2]
    assert max(v for v in a['y'] if v is not None)==30000
    assert min(v for v in a['y'] if v is not None)==-29000
    assert min(v for v in b['x'] if v is not None)==0
    assert .009 <= max(v for v in b['x'] if v is not None)<.01
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

def test_unknown_log_rejected(tmp_path):
    folder=write_fixture(tmp_path)
    raw=(folder/'A.RNG').read_bytes().replace(b'event,',b'other,',1)
    with pytest.raises(ValueError,match='Unknown'):parse(raw)

def test_truncated_payload_rejected(tmp_path):
    folder=write_fixture(tmp_path)
    with pytest.raises(ValueError,match='Truncated'):parse((folder/'A.RNG').read_bytes()[:-1])

def test_large_timestamp_translation_preserves_relative_samples(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    original=waveform(boards,0,.01,pixels=30)
    shift=10**18+7
    for board in boards.values():
        board['anchors']=[(count,ns+shift,epoch,frames) for count,ns,epoch,frames in board['anchors']]
        for event in board['logs']['event']: event['local_ns']=str(int(event['local_ns'])+shift)
        for clock in board['logs']['clock']: clock['master_ns']=str(int(clock['master_ns'])+shift)
        for pair in board['logs'].get('pair',[]):
            for key in ['a_master_ns','b_master_ns']:pair[key]=str(int(pair[key])+shift)
    shifted=waveform(boards,0,.01,pixels=30)
    assert original==shifted
    assert build_report(boards)['pairs'][0]['time_s']==pytest.approx(.001)


def long_wave_fixture(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    b=boards['B']
    b['pcm']=np.zeros((48000,2),dtype='<i2')
    b['anchors']=[(i*48,1_001_000_000+i*1_000_000,1,48) for i in range(1,1001)]
    b['meta']['frames']=48000
    b['logs']['event']=[{'event':str(i),'local_ns':str(1_001_000_000+t),'quality':'800','locked':'1'} for i,t in [(1,200_000_000),(2,700_000_000)]]
    b['logs']['clock']=[{'event':str(i),'master_ns':str(1_000_000_000+t),'origin':'0','offset':'1000000','slope':'0'} for i,t in [(1,200_000_000),(2,700_000_000)]]
    b['pcm'][int(.72*48000),0]=21000
    b['pcm'][int(.85*48000),0]=-22000
    b['pcm'][int(.91*48000),0]=31000
    return boards


def test_last_onset_keeps_burst_but_not_distant_unmapped_samples(tmp_path):
    boards=long_wave_fixture(tmp_path)
    b=waveform(boards,0,1,pixels=1000)['traces'][2]
    assert 21000 in b['y'] and -22000 in b['y']
    assert 31000 not in b['y']
    assert min(x for x in b['x'] if x is not None)>=.1
    assert max(x for x in b['x'] if x is not None)<=.86
    # With no usable model, retain the original event-to-event interpolation only.
    boards['B']['logs']['clock'][1]['offset']='2000000'
    b=waveform(boards,0,1,pixels=1000)['traces'][2]
    assert 21000 not in b['y']
    assert max(x for x in b['x'] if x is not None)<=.7


@pytest.mark.parametrize('break_kind',['epoch','sample_gap','unlock'])
def test_model_margins_never_cross_discontinuity_or_unlock(tmp_path,break_kind):
    boards=long_wave_fixture(tmp_path);b=boards['B']
    if break_kind=='unlock':
        b['logs']['event'].append({'event':'3','local_ns':'1731000000','quality':'1','locked':'0'})
    else:
        b['anchors']=[(count+(48 if break_kind=='sample_gap' and i>=750 else 0),ns,
                       2 if break_kind=='epoch' and i>=750 else ep,frames)
                      for i,(count,ns,ep,frames) in enumerate(b['anchors'])]
    trace=waveform(boards,0,1,pixels=1000)['traces'][2]
    assert -22000 not in trace['y']
    assert max(x for x in trace['x'] if x is not None)<=(.7 if break_kind=='unlock' else .75)


def test_isolated_event_model_and_unlocked_event(tmp_path):
    boards=long_wave_fixture(tmp_path);b=boards['B']
    b['logs']['event']=b['logs']['event'][1:]
    b['logs']['clock']=b['logs']['clock'][1:]
    assert alignment_segments(b)==[]
    assert waveform_alignment_segments(b)
    assert 21000 in waveform(boards,0,1)['traces'][2]['y']
    b['logs']['event'][0]['locked']='0'
    assert waveform_alignment_segments(b)==[]


def test_unmapped_interval_inside_one_block_breaks_trace(tmp_path):
    boards=long_wave_fixture(tmp_path);b=boards['B']
    b['anchors']=[(48000,2_001_000_000,1,48000)]
    b['logs']['event'].append({'event':'3','local_ns':'1451000000','quality':'1','locked':'0'})
    b['pcm'][24000,0]=32000
    trace=waveform(boards,0,1)['traces'][2]
    assert None in trace['x']
    assert 32000 not in trace['y']
    assert 21000 in trace['y']


def test_model_margins_preserve_precision_with_drift_and_large_timestamps(tmp_path):
    boards=long_wave_fixture(tmp_path)
    for c in boards['B']['logs']['clock']:
        c['slope']='0.00005';c['origin']='1001000000'
        c['master_ns']=str(int(c['master_ns'])-(10000 if c['event']=='1' else 35000))
    original=waveform(boards,0,1)
    shift=10**18+7
    for b in boards.values():
        b['anchors']=[(count,ns+shift,epoch,frames) for count,ns,epoch,frames in b['anchors']]
        for e in b['logs']['event']:e['local_ns']=str(int(e['local_ns'])+shift)
        for c in b['logs']['clock']:
            c['master_ns']=str(int(c['master_ns'])+shift)
            c['origin']=str(int(c['origin'])+shift)
    assert waveform(boards,0,1)==original


def test_detection_marker_times_and_signed_arrival_difference(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    # Large common origin must not lose a 3 ns inter-board arrival difference.
    shift=10**18+7
    for b in boards.values():
        b['anchors']=[(count,ns+shift,ep,frames) for count,ns,ep,frames in b['anchors']]
        for e in b['logs']['event']:e['local_ns']=str(int(e['local_ns'])+shift)
        for c in b['logs']['clock']:c['master_ns']=str(int(c['master_ns'])+shift)
    p=boards['A']['logs']['pair'][0]
    p['a_master_ns']=str(1_001_000_000+shift)
    p['b_master_ns']=str(1_001_000_003+shift)
    boards['B']['logs']['clock'][0]['master_ns']=p['b_master_ns']
    report=build_report(boards)
    assert report['pairs'][0]['arrival_delta_ns']=='3'
    assert report['pairs'][0]['arrival_delta_us']==.003
    assert report['pairs'][0]['delay_us']==1  # Algorithm best_ns is a different quantity.
    assert report['boards']['A']['event_markers'][0]['master_time_s']==.001
    assert report['boards']['B']['event_markers'][0]['master_time_s']==.001000003
    assert report['boards']['B']['event_markers'][0]['local_time_s']==.001


def test_markers_include_unpaired_unlocked_and_missing_clock_events(tmp_path):
    boards,_=read_capture(write_fixture(tmp_path))
    boards['B']['logs']['clock']=boards['B']['logs']['clock'][:1]
    boards['B']['logs']['event'][0]['locked']='0'
    report=build_report(boards)
    markers=report['boards']['B']['event_markers']
    assert len(markers)==2
    assert markers[0]['locked'] is False
    assert markers[1]['master_time_s'] is None
    assert markers[1]['local_time_s']==.008
