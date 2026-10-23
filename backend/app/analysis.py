"""RNG1 analysis. Raw records remain strings; time math stays on the server."""
from collections import defaultdict
from pathlib import Path
import hashlib
import math
import re
import numpy as np
from .legacy_decoder import parse, fnv1a, SCHEMAS

VERSION = 'rng1-analysis-0.1.0'
REASONS = {0: '唯一配对', 1: '次佳候选过于接近', 2: '候选溢出', 3: '脉冲间时差不一致', 4: '候选数量无效'}

def read_capture(folder: Path):
    marker = (folder / 'COMPLETE.TXT').read_text('ascii')
    expected = re.findall(r'([AB]) bytes=(\d+) fnv1a=([0-9A-Fa-f]{8})', marker)
    if not marker.startswith('RNG1 complete') or [e[0] for e in expected] != ['A','B']:
        raise ValueError('完成标记无效：需要按顺序包含 A、B 文件长度及校验值')
    boards = {}
    digest = hashlib.sha256()
    for board, size, check in expected:
        data = (folder / f'{board}.RNG').read_bytes()
        if len(data) != int(size) or fnv1a(data) != int(check,16):
            raise ValueError(f'{board}.RNG 文件长度或校验值不一致')
        meta, pcm, anchors, logs = parse(data)
        if meta['board'] != board:
            raise ValueError(f'{board}.RNG 的板角色与文件名不一致')
        if not anchors or not 0 < meta['rate'] <= 384000 or any(a[3] <= 0 for a in anchors):
            raise ValueError(f'{board}: 无有效音频锚点或采样率无效')
        if not all(math.isfinite(float(value)) for row in logs for value in row[1:]):
            raise ValueError(f'{board}: 日志存在非有限数值')
        records = defaultdict(list)
        for row in logs:
            records[row[0]].append(dict(zip(SCHEMAS[row[0]], row[1:])))
        boards[board] = {'meta':meta, 'pcm':np.frombuffer(pcm,dtype='<i2').reshape(-1,2),
                         'anchors':anchors, 'logs':dict(records), 'log_rows':logs}
        digest.update(board.encode()); digest.update(data)
    return boards, digest.hexdigest()

def block_times(board):
    """Piecewise local sample times; never interpolate across an epoch or sample gap."""
    position = 0
    previous = None
    for count, ns, epoch, frames in board['anchors']:
        contiguous = previous is not None and epoch == previous[2] and count - previous[0] == frames
        step = (ns-previous[1])/frames if contiguous else 1e9/board['meta']['rate']
        if not 0.5e9/board['meta']['rate'] < step < 1.5e9/board['meta']['rate']:
            step = 1e9/board['meta']['rate']; contiguous = False
        yield position, frames, ns, step, epoch, contiguous
        position += frames
        previous = (count,ns,epoch)

def epoch_at(board, local_ns):
    for _,frames,end,step,epoch,_ in block_times(board):
        if 0 < end-local_ns <= frames*step:
            return epoch
    return None

def event_records(board):
    clocks = defaultdict(list)
    for c in board['logs'].get('clock',[]): clocks[c['event']].append(c)
    candidates = defaultdict(list)
    for c in board['logs'].get('candidate',[]): candidates[c['event']].append(c)
    result=[]
    for event in board['logs'].get('event',[]):
        matches=clocks[event['event']]
        clock=matches[0] if len(matches)==1 else None
        result.append({**event,'clock':clock,'candidates':candidates[event['event']],
                       'epoch':epoch_at(board,int(event['local_ns']))})
    return result

def alignment_segments(board):
    events=sorted(event_records(board), key=lambda e:int(e['local_ns']))
    segments=[]
    for a,b in zip(events,events[1:]):
        if not a['clock'] or not b['clock'] or a['locked']!='1' or b['locked']!='1': continue
        if a['epoch'] is None or a['epoch']!=b['epoch']: continue
        la,lb=int(a['local_ns']),int(b['local_ns'])
        ma,mb=int(a['clock']['master_ns']),int(b['clock']['master_ns'])
        if 0 < lb-la <= 1_100_000_000 and abs((mb-ma)/(lb-la)-1)<0.001:
            # Reject sample discontinuities even if the epoch number was not changed.
            invalid=any(not contiguous and la < end-frames*step < lb
                        for _,frames,end,step,_,contiguous in block_times(board))
            if not invalid: segments.append((la,lb,ma,mb,a['epoch']))
    return segments

def base_time(boards):
    _,frames,ns,step,_,_=next(block_times(boards['A']))
    return ns-int(round(frames*step))

def build_report(boards):
    base=base_time(boards)
    events={b:event_records(v) for b,v in boards.items()}
    maps={b:defaultdict(list) for b in boards}
    for b, rows in events.items():
        for e in rows:
            if e['clock']: maps[b][e['clock']['master_ns']].append(e)
    pairs=[]
    temperature=boards['A']['meta'].get('temperature_deci_c',250)/10
    speed=331.3+0.606*temperature
    for i,p in enumerate(boards['A']['logs'].get('pair',[])):
        associated={}
        for b,field in [('A','a_master_ns'),('B','b_master_ns')]:
            found=maps[b][p[field]]
            associated[b]=found[0] if len(found)==1 else None
        outcome=int(p['outcome_1_ok_2_ambiguous'])
        pairs.append({'index':i, 'time_s':(int(p['a_master_ns'])-base)/1e9,
                      'outcome':outcome,'reason_label':REASONS.get(int(p['reason']),'未知原因'),
                      'distance_mm':abs(int(p['best_ns']))*speed/1e6 if int(p['best_score'])>0 else None,
                      'delay_us':int(p['best_ns'])/1000, 'raw':p,'events':associated})
    accepted=[p['distance_mm'] for p in pairs if p['outcome']==1 and p['distance_mm'] is not None]
    board_reports={}
    for b,v in boards.items():
        rows=v['logs'].get('status',[])
        clock_events=[]
        for e in events[b]:
            if e['clock']:
                clock_events.append({'event':e['event'],'time_s':(int(e['clock']['master_ns'])-base)/1e9,
                    'offset_us':float(e['clock']['offset'])/1000,'locked':e['locked']=='1'})
        board_reports[b]={'meta':v['meta'], 'duration_s':v['meta']['frames']/v['meta']['rate'],
            'counts':{k:len(rows) for k,rows in v['logs'].items()}, 'clock_events':clock_events,
            'status':rows,'dsp':v['logs'].get('dsp',[]),'events':events[b],
            'discontinuities':sum(not row[5] for row in list(block_times(v))[1:]),
            'epochs':sorted(set(a[2] for a in v['anchors']))}
    warnings=[]
    if any(v['meta'].get('log_overflow',0) for v in boards.values()): warnings.append('日志发生溢出，统计可能不完整。')
    if any(v['discontinuities'] for v in board_reports.values()): warnings.append('音频存在断流或 epoch 变化，已中断跨段连接。')
    missing=sum(any(e is None for e in p['events'].values()) for p in pairs)
    if missing: warnings.append(f'{missing} 个配对无法通过主时钟时间唯一关联两侧事件。')
    if not pairs: warnings.append('本轮没有 pair 日志，无法计算配对统计；仍可查看音频与状态。')
    segments=alignment_segments(boards['B'])
    if not segments: warnings.append('B 板缺少连续且锁定的时钟事件，主时钟视图不绘制 B 音频。可切换到各板录音时间查看。')
    end=max(ns for _,_,ns,_,_,_ in block_times(boards['A']))
    return {'analysis_version':VERSION,'base_master_ns':str(base),'duration_s':(end-base)/1e9,
            'boards':board_reports,'pairs':pairs,'warnings':warnings,
            'stats':{'pairs':len(pairs),'accepted':sum(p['outcome']==1 for p in pairs),
                'ambiguous':sum(p['outcome']==2 for p in pairs),'rejected':sum(p['outcome']==0 for p in pairs),
                'mean_mm':float(np.mean(accepted)) if accepted else None,
                'std_mm':float(np.std(accepted)) if accepted else None,
                'temperature_c':temperature},
            'alignment':{'method':'A 使用音频块锚点；B 仅在同 epoch、无断流且间隔 ≤1.1 s 的锁定事件间按记录时钟线性插值，不向区间外推。',
                         'b_ranges': [[(s[2]-base)/1e9,(s[3]-base)/1e9] for s in segments]},
            'distance_note':'按 pair.best_ns 与封存温度换算，偏置假设为 0；不是固件最终显示距离，也不等于测距通过率。'}

def json_safe(value):
    if isinstance(value,dict): return {k:json_safe(v) for k,v in value.items()}
    if isinstance(value,list): return [json_safe(v) for v in value]
    if isinstance(value,int) and abs(value)>2**53-1: return str(value)
    return value

def waveform(boards, start, end, pixels=1200, mode='master'):
    base=base_time(boards)
    traces=[]
    for b,board in boards.items():
        parts=[]
        ownbase=next(block_times(board))
        ownbase=ownbase[2]-int(round(ownbase[1]*ownbase[3]))
        segments=alignment_segments(board) if b=='B' and mode=='master' else []
        for pos,frames,ns,step,epoch,continuous in block_times(board):
            # Subtract the integer reference before converting to float.
            local_relative=(ns-ownbase)-np.arange(frames,0,-1)*step
            if mode=='local': t=local_relative/1e9
            elif b=='A': t=((ns-base)-np.arange(frames,0,-1)*step)/1e9
            else:
                t=np.full(frames,np.nan)
                for la,lb,ma,mb,ep in segments:
                    if ep!=epoch or ns < la or ns-frames*step > lb: continue
                    rel_la=la-ownbase; rel_lb=lb-ownbase
                    mask=(local_relative>=rel_la)&(local_relative<=rel_lb)
                    t[mask]=((ma-base)+(local_relative[mask]-rel_la)*(mb-ma)/(lb-la))/1e9
            valid=np.isfinite(t)&(t>=start)&(t<=end)
            indices=np.flatnonzero(valid)
            if indices.size: parts.append((t[indices],board['pcm'][pos+indices],continuous,epoch))
        for channel in range(2):
            xs=[]; ys=[]
            previous=None
            # Equal time buckets retain extrema, in temporal order.
            bucket=max((end-start)/pixels,1e-9)
            for t,pcm,continuous,epoch in parts:
                if previous is not None and (not continuous or epoch!=previous[1] or t[0]-previous[0]>2/board['meta']['rate']):
                    xs.append(None);ys.append(None)
                groups=np.floor((t-start)/bucket).astype(np.int64)
                boundaries=np.r_[0,np.flatnonzero(np.diff(groups))+1,len(t)]
                for lo,hi in zip(boundaries[:-1],boundaries[1:]):
                    vals=pcm[lo:hi,channel]
                    for j in sorted(set([int(np.argmin(vals))+lo,int(np.argmax(vals))+lo])):
                        xs.append(round(float(t[j]),9));ys.append(int(pcm[j,channel]))
                previous=(t[-1],epoch)
            traces.append({'board':b,'channel':channel+1,'x':xs,'y':ys})
    return {'mode':mode,'start':start,'end':end,'traces':traces}
