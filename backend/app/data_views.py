"""Lossless, paginated views over all decoded sections of an RNG1 capture."""
import csv
import io
import json
from .legacy_decoder import SCHEMAS

TABLES = {
    'metadata': ('文件元数据', 'JSON 头部中的全部原始字段；封存时间与配置均为记录值。'),
    'logs': ('全部日志', '按原文件顺序展示全部日志，记录序号从 1 开始；分类表可查看每个字段。'),
    'anchors': ('音频时间锚点', '块末锚点原值，样本末位置与 WAV 帧末位置均为右开边界。'),
    'pcm': ('PCM 逐帧数据', '原始 int16 双声道样本，没有抽稀或归一化；录音时间按名义采样率计算，未作主时钟对齐。'),
    'trigger': ('采集触发', '触发时的本板 tick，单位 ms。'),
    'event': ('本地检测事件', '本地事件计数、检测时刻、质量与锁定标志。'),
    'clock': ('事件时钟映射', '事件对应的主时钟时间与同步模型快照；原始小数精度保留。'),
    'candidate': ('候选峰', '本地事件下各候选的三脉冲偏移与质量；原始候选编号从 0 开始。'),
    'pair': ('配对诊断', '固件记录的配对结果与评分；协议编号不等同于本地事件计数，候选编号从 1 开始。'),
    'wave_clock': ('波形时钟', '记录的采样周期及主时钟原点。'),
    'ui': ('界面与设置', '本板 tick、页面、温度与设置修订号。'),
    'status': ('运行状态', '固件周期状态快照；计数器通常为累计值，不将重复快照当作独立测量。'),
    'dsp': ('DSP 诊断', '检测器各阶段计数与质量指标。'),
}

LABELS = {
    'field':'字段','value':'原始值','record_number':'记录序号','record_type':'日志类型','record':'原始 CSV 记录',
    'frame_index':'帧序号（从 0 开始）','recording_s':'录音时间 / s','ch1':'CH1 / int16','ch2':'CH2 / int16',
    'wav_frame_end':'WAV 帧末位置','absolute_sample_end':'绝对样本末位置','local_anchor_ns':'块末本地时间 / ns',
    'audio_epoch':'音频 epoch','block_frames':'块帧数','tick_ms':'本板 tick / ms','event':'本地事件编号',
    'local_ns':'本地时间 / ns','master_ns':'主时钟时间 / ns','quality':'质量','locked':'时钟锁定',
    'origin':'模型原点 / ns','offset':'时钟偏移 / ns','slope':'时钟斜率','index_zero_based':'候选编号（从 0 开始）',
    'pulse0_offset_ns':'脉冲 0 偏移 / ns','pulse1_offset_ns':'脉冲 1 偏移 / ns','pulse2_offset_ns':'脉冲 2 偏移 / ns',
    'event_a_id':'A 通信序号','event_b_id':'B 通信序号','a_master_ns':'A 主时钟 / ns','b_master_ns':'B 主时钟 / ns',
    'outcome_1_ok_2_ambiguous':'配对结果（1 唯一 / 2 歧义 / 0 不一致）','reason':'原因代码',
    'best_ns':'最佳时差 / ns','runner_ns':'次佳时差 / ns','best_score':'最佳评分','runner_score':'次佳评分',
    'best_span_ns':'最佳脉冲跨度 / ns','runner_span_ns':'次佳脉冲跨度 / ns',
    'best_a':'最佳 A 候选','best_b':'最佳 B 候选','runner_a':'次佳 A 候选','runner_b':'次佳 B 候选',
    'period_ps':'采样周期 / ps','origin_master_ns':'主时钟原点 / ns','page':'页面编号',
    'temperature_deci_c':'温度 / 0.1 °C','settings_revision':'设置修订号','distance_mm':'固件显示距离 / mm',
    'result_delta_us':'结果时差 / μs','sync_error_ns':'同步误差 / ns','sample_period_ps':'采样周期 / ps',
    'events':'本地事件计数','event_rx':'接收事件计数','results':'结果计数','ambiguous':'歧义计数',
    'inconsistent':'不一致计数','valid':'显示结果有效','batch_stage':'批次阶段','batch_count':'批次计数',
    'batch_used':'批次采用数','batch_span_mm':'批次跨度 / mm','audio_drops':'音频丢弃计数',
    'audio_gaps':'音频间断计数','audio_overruns':'音频溢出计数','unlocked_events':'未锁定事件计数',
    'distance_rejects':'距离拒绝计数','cadence_rejects':'节奏拒绝计数',
    'coarse_passed':'粗检通过数','fail_pulse0':'脉冲 0 失败数','fail_pulse1':'脉冲 1 失败数',
    'fail_pulse2':'脉冲 2 失败数','gap_rejected':'间隔拒绝数','signatures':'签名数','no_candidates':'无候选计数',
    'candidate_overflow':'候选溢出数','coarse_max':'粗检最大值','pulse0_max':'脉冲 0 最大值',
    'pulse1_max':'脉冲 1 最大值','pulse2_max':'脉冲 2 最大值','gap_min_ratio':'最小间隔比',
}

def raw_string(value):
    if isinstance(value,(dict,list,bool)) or value is None:
        return json.dumps(value,ensure_ascii=False,allow_nan=False)
    return str(value)

def table_schema(table):
    if table=='metadata':return ['field','value']
    if table=='anchors':return ['wav_frame_end','absolute_sample_end','local_anchor_ns','audio_epoch','block_frames']
    if table=='pcm':return ['frame_index','recording_s','ch1','ch2']
    if table=='logs':return ['record_number','record_type','record']
    return SCHEMAS[table]

def table_count(board,table):
    if table=='metadata':return len(board['meta'])
    if table=='anchors':return len(board['anchors'])
    if table=='pcm':return len(board['pcm'])
    if table=='logs':return len(board['log_rows'])
    return len(board['logs'].get(table,[]))

def table_rows(board,table,offset=0,limit=None):
    stop=table_count(board,table) if limit is None else offset+limit
    if table=='metadata':
        for key,value in list(board['meta'].items())[offset:stop]:yield {'field':key,'value':raw_string(value)}
    elif table=='anchors':
        position=sum(a[3] for a in board['anchors'][:offset])
        for count,ns,epoch,frames in board['anchors'][offset:stop]:
            position+=frames
            yield dict(zip(table_schema(table),map(str,[position,count,ns,epoch,frames])))
    elif table=='pcm':
        rate=board['meta']['rate']
        for i in range(offset,min(stop,len(board['pcm']))):
            yield {'frame_index':str(i),'recording_s':f'{i/rate:.9f}',
                   'ch1':str(int(board['pcm'][i,0])),'ch2':str(int(board['pcm'][i,1]))}
    elif table=='logs':
        for i,row in enumerate(board['log_rows'][offset:stop],start=offset+1):
            yield {'record_number':str(i),'record_type':row[0],'record':','.join(row)}
    else:
        yield from board['logs'].get(table,[])[offset:stop]

def table_page(board,table,offset,limit):
    return {'table':table,'title':TABLES[table][0],'description':TABLES[table][1],
            'columns':[{'key':key,'label':LABELS.get(key,key)} for key in table_schema(table)],
            'rows':list(table_rows(board,table,offset,limit)), 'total':table_count(board,table),
            'offset':offset,'limit':limit,
            'catalog':[{'key':key,'title':title,'count':table_count(board,key)} for key,(title,_) in TABLES.items()]}

def csv_chunks(board,table):
    stream=io.StringIO(newline=''); writer=csv.writer(stream)
    keys=table_schema(table)
    writer.writerow(keys)
    yield '\ufeff'+stream.getvalue();stream.seek(0);stream.truncate(0)
    for i,row in enumerate(table_rows(board,table)):
        writer.writerow([row[k] for k in keys])
        if (i+1)%1000==0:
            yield stream.getvalue();stream.seek(0);stream.truncate(0)
    if stream.tell():yield stream.getvalue()
