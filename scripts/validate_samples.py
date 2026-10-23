"""Validate real captures, event joins and waveform limits without modifying samples."""
import json
import sys
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
from app.analysis import read_capture,build_report,waveform,json_safe

root=Path(sys.argv[1]);rows=[]
for marker in sorted(root.rglob('COMPLETE.TXT')):
    start=time.perf_counter()
    boards,_=read_capture(marker.parent)
    report=json_safe(build_report(boards))
    for pair in report['pairs']:
        for board,field in [('A','a_master_ns'),('B','b_master_ns')]:
            event=pair['events'][board]
            if event:assert event['clock']['master_ns']==pair['raw'][field]
    # Validate envelope sizes and monotonicity on one full waveform per group.
    wave=waveform(boards,0,report['duration_s'],900,'master')
    for trace in wave['traces']:
        times=[x for x in trace['x'] if x is not None]
        assert all(a<=b for a,b in zip(times,times[1:])),marker.parent
        assert len(trace['x'])==len(trace['y'])
        assert all(-32768<=y<=32767 for y in trace['y'] if y is not None)
    row={'folder':str(marker.parent.relative_to(root)),'pairs':len(report['pairs']),
         'matched_both':sum(all(p['events'].values()) for p in report['pairs']),
         'warnings':report['warnings'],'wave_points':sum(len(t['x']) for t in wave['traces']),
         'elapsed_s':round(time.perf_counter()-start,3)}
    rows.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
target=Path(__file__).resolve().parents[1]/'docs'/'validation-samples.json'
target.write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
print('Validated',len(rows),'rounds;',sum(r['pairs'] for r in rows),'pairs;',sum(r['matched_both'] for r in rows),'matched both')
