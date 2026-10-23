"""Run the built local app with one process; no global PATH modifications."""
import json
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
URL='http://127.0.0.1:8000'
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))

def healthy():
    try:
        with opener.open(URL+'/api/health',timeout=1) as response:
            data=json.load(response)
            return data.get('mode')=='local' and data.get('version')=='0.1.0'
    except Exception: return False

if not (ROOT/'frontend'/'dist'/'index.html').is_file():
    raise SystemExit('Build the frontend first: cd frontend && npm.cmd ci && npm.cmd run build')
if healthy():
    print('An existing Ranging Studio service is running at '+URL)
    if '--no-browser' not in sys.argv:webbrowser.open(URL)
    raise SystemExit(0)
process=subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8000'],cwd=ROOT/'backend')
try:
    for _ in range(100):
        if process.poll() is not None:raise SystemExit(process.returncode)
        if healthy():break
        time.sleep(.1)
    else:raise RuntimeError('Local server did not become ready')
    print('\nRanging Studio: '+URL+'\nKeep this window open. Press Ctrl+C to stop.\n',flush=True)
    if '--no-browser' not in sys.argv:webbrowser.open(URL)
    process.wait()
except KeyboardInterrupt:pass
finally:
    if process.poll() is None:
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill()
