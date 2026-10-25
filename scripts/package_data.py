"""Create a consistent migration snapshot without changing local experiments."""
import hashlib
import json
import re
import shutil
import sqlite3
import tarfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
source = ROOT / 'data'
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')
snapshot = ROOT / 'artifacts' / f'data-snapshot-{stamp}'
snapshot.mkdir(parents=True)
with sqlite3.connect((source/'studio.sqlite3').as_uri()+'?mode=ro', uri=True) as live:
    with sqlite3.connect(snapshot/'studio.sqlite3') as target:
        live.backup(target)
with sqlite3.connect(snapshot/'studio.sqlite3') as db:
    if db.execute("SELECT count(*) FROM experiments WHERE status IN ('queued','processing')").fetchone()[0]:
        raise SystemExit('Wait for local parsing jobs to finish, then snapshot again.')
    if db.execute("SELECT count(*) FROM ai_runs WHERE status='running'").fetchone()[0]:
        raise SystemExit('Wait for local AI jobs to finish, then snapshot again.')
    ids = [row[0] for row in db.execute('SELECT id FROM experiments')]
    ai_count = db.execute('SELECT count(*) FROM ai_runs').fetchone()[0]
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
for eid in ids:
    if not re.fullmatch('[a-f0-9]{32}', eid):
        raise SystemExit('Unexpected experiment ID; aborting snapshot.')
    if any(path.is_symlink() for path in (source/eid).rglob('*')):
        raise SystemExit('Unexpected symlink; aborting snapshot.')
    shutil.copytree(source/eid, snapshot/eid)
# Detect concurrent metadata edits/imports rather than silently omit them.
with sqlite3.connect((source/'studio.sqlite3').as_uri()+'?mode=ro', uri=True) as live, sqlite3.connect(snapshot/'studio.sqlite3') as copy:
    for table in ('experiments', 'ai_runs'):
        assert live.execute(f'SELECT * FROM {table} ORDER BY id').fetchall() == copy.execute(f'SELECT * FROM {table} ORDER BY id').fetchall(), 'Local records changed; take another snapshot.'
files = {p.relative_to(snapshot).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
         for p in snapshot.rglob('*') if p.is_file()}
manifest = {'experiments': len(ids), 'ai_runs': ai_count, 'files': files}
(snapshot/'migration-manifest.json').write_text(json.dumps(manifest, indent=2), 'utf-8')
output = ROOT/'artifacts'/'data-migration.tar.gz'
def metadata(info):
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    info.mode = 0o640
    return info
with tarfile.open(output, 'w:gz') as archive:
    for path in sorted(snapshot.rglob('*')):
        if path.is_file():
            archive.add(path, arcname=path.relative_to(snapshot).as_posix(), filter=metadata)
print(json.dumps({'experiments':len(ids), 'ai_runs':ai_count, 'files':len(files),
                  'archive_bytes':output.stat().st_size,
                  'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}))
