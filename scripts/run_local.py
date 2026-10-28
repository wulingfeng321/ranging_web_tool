"""Build current sources when needed, then run the local app."""
import hashlib
import json
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / 'frontend'
DIST = FRONTEND / 'dist'
URL = 'http://127.0.0.1:8000'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def source_fingerprint():
    paths = list((FRONTEND / 'src').rglob('*'))
    paths += list((FRONTEND / 'public').rglob('*'))
    paths += [p for p in FRONTEND.iterdir() if p.suffix in {'.json', '.ts', '.js', '.mjs', '.html', '.css'}]
    digest = hashlib.sha256()
    for path in sorted(p for p in paths if p.is_file()):
        digest.update(path.relative_to(FRONTEND).as_posix().encode())
        digest.update(b'\0')
        digest.update(path.read_bytes())
    return digest.hexdigest()


def ensure_build():
    fingerprint = source_fingerprint()
    stamp = DIST / '.source-fingerprint'
    if (DIST / 'index.html').is_file() and stamp.is_file() and stamp.read_text() == fingerprint:
        return
    npm = shutil.which('npm.cmd') or shutil.which('npm')
    if not npm:
        raise SystemExit('Node.js/npm is required to update the frontend. Install Node.js and retry.')
    if not (FRONTEND / 'node_modules').is_dir():
        raise SystemExit('Install frontend dependencies first: cd frontend && npm.cmd ci')
    print('Updating frontend from current sources...', flush=True)
    subprocess.run([npm, 'run', 'build'], cwd=FRONTEND, check=True)
    stamp.write_text(fingerprint)


def healthy():
    try:
        with opener.open(URL + '/api/health', timeout=1) as response:
            data = json.load(response)
            return data.get('mode') == 'local' and data.get('version') == '0.1.0'
    except Exception:
        return False


def page_url():
    digest = hashlib.sha256((DIST / 'index.html').read_bytes()).hexdigest()[:16]
    return URL + '/?build=' + digest


def verify_page():
    with opener.open(page_url(), timeout=3) as response:
        if response.read() != (DIST / 'index.html').read_bytes():
            raise SystemExit('Port 8000 serves a different frontend. Close the old local server window and run start-local.cmd again.')


def main():
    ensure_build()
    if healthy():
        verify_page()
        print('Current frontend verified on existing local service: ' + page_url())
        if '--no-browser' not in sys.argv:
            webbrowser.open(page_url())
        return
    process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], cwd=ROOT / 'backend')
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise SystemExit(process.returncode)
            if healthy():
                break
            time.sleep(.1)
        else:
            raise RuntimeError('Local server did not become ready')
        verify_page()
        print('\nRanging Studio: ' + page_url() + '\nKeep this window open. Press Ctrl+C to stop.\n', flush=True)
        if '--no-browser' not in sys.argv:
            webbrowser.open(page_url())
        process.wait()
    except KeyboardInterrupt:
        pass
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    main()
