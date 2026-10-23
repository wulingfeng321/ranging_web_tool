"""Import original files through the same HTTP API as the UI, without modifying source."""
import argparse
from pathlib import Path
import httpx

parser=argparse.ArgumentParser()
parser.add_argument('root',type=Path)
parser.add_argument('--url',default='http://127.0.0.1:8000')
parser.add_argument('--limit',type=int,default=3)
args=parser.parse_args()
folders=[p.parent for p in sorted(args.root.rglob('COMPLETE.TXT'))]
with httpx.Client(base_url=args.url,timeout=120,trust_env=False) as client:
    listing=client.get('/api/experiments');listing.raise_for_status()
    existing={e['name'] for e in listing.json()}
    chosen=[]
    for folder in folders:
        # First import a representative from each experiment group.
        group=folder.parent if folder.name.startswith('R') and folder.parent!=args.root else folder
        if group not in [g for g,_ in chosen]:chosen.append((group,folder))
    if args.limit==0:chosen=[(f,f) for f in folders]
    else:chosen=chosen[:args.limit]
    for _,folder in chosen:
        name=str(folder.relative_to(args.root)).replace('\\',' / ').replace('/',' / ')
        if name in existing:continue
        names=['A.RNG','B.RNG','COMPLETE.TXT']
        result=client.post('/api/experiments',files=[('files',(n,(folder/n).read_bytes(),'application/octet-stream')) for n in names],data={'name':name,'notes':'本地真实样本导入；原始数据未修改。真实距离待人工确认。'})
        result.raise_for_status()
        print(result.json()['id'],name,flush=True)
