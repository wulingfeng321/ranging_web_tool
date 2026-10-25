"""Package tracked source and built UI; never include local data or credentials."""
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
output = ROOT / 'artifacts' / 'ranging-release.tar.gz'
files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
allowed = ('backend/app/', 'backend/tests/', 'config/prompts/', 'deploy/')
sources = [ROOT / name for name in files if name and (
    name.startswith(allowed) or name in (
        'backend/requirements.txt', 'backend/requirements.in', 'config/ai.example.toml'))]
dist = ROOT / 'frontend' / 'dist'
if not (dist / 'index.html').is_file():
    raise SystemExit('Build frontend first.')
sources += [p for p in dist.rglob('*') if p.is_file()]
output.parent.mkdir(exist_ok=True)
def safe_metadata(info):
    info.mode = 0o644
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    return info

with tarfile.open(output, 'w:gz') as archive:
    for path in sorted(sources):
        archive.add(path, arcname=path.relative_to(ROOT).as_posix(), recursive=False,
                    filter=safe_metadata)
print(output)
