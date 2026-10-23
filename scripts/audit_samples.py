"""Read-only capture audit; usage: python scripts/audit_samples.py ROOT."""
import sys
import json
import hashlib
from collections import Counter
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.legacy_decoder import parse, fnv1a
import re

def audit(root):
    result = []
    for marker in sorted(root.rglob('COMPLETE.TXT')):
        item = {'folder': str(marker.parent.relative_to(root)), 'boards': {}}
        try:
            expected = re.findall(r'([AB]) bytes=(\d+) fnv1a=([0-9A-Fa-f]{8})', marker.read_text('ascii'))
            assert [r[0] for r in expected] == ['A', 'B'], 'Invalid marker'
            for board, size, digest in expected:
                raw = (marker.parent / f'{board}.RNG').read_bytes()
                assert len(raw) == int(size) and fnv1a(raw) == int(digest, 16), 'Checksum mismatch'
                meta, pcm, anchors, logs = parse(raw)
                item['boards'][board] = {'meta': meta, 'counts': dict(Counter(r[0] for r in logs)),
                    'first_anchor': anchors[0], 'last_anchor': anchors[-1],
                    'examples': {kind: next((r for r in logs if r[0] == kind), None) for kind in ('event','clock','pair','wave_clock','ui','status')},
                    'epochs': list(sorted(set(a[2] for a in anchors))), 'pcm_sha256': hashlib.sha256(pcm).hexdigest()}
            item['supported'] = True
        except Exception as exc:
            item['supported'] = False
            item['error'] = str(exc)
        result.append(item)
    return result

if __name__ == '__main__':
    report = audit(Path(sys.argv[1]))
    target = Path(__file__).resolve().parents[1] / 'docs' / 'sample-audit.json'
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'rounds':len(report),'supported':sum(x['supported'] for x in report),'failures':[(x['folder'],x.get('error')) for x in report if not x['supported']], 'representative': report[-1]}, ensure_ascii=False))
