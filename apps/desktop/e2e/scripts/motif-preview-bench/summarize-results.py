import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser(description='Validate and summarize completed preview benchmark cases.')
parser.add_argument('files', nargs='*', default=['preview-result.json'])
parser.add_argument('--expect', type=int, default=13, help='Expected completed case count (default: all 13 cases).')
parser.add_argument('--directory', type=Path, default=Path(os.environ.get('WEFTCUT_MOTIF_BENCH_DIR',
    Path(__file__).resolve().parents[3] / 'reports/motif-preview-bench')))
args = parser.parse_args()
root = args.directory.resolve()
cases = [c for name in args.files for c in json.load(open(root / name))['cases']]
assert len(cases) == args.expect, f'Expected {args.expect} cases, got {len(cases)}'
assert len({c['name'] for c in cases}) == len(cases), 'Duplicate case names'
summary = []
for c in cases:
    assert c.get('ok'), c['name']
    assert not c['pageErrors'], c['name']
    assert c['measurement']['positionUs'] > c['durationMs'] * 900, c['name']
    assert c['settings']['prebake_motifs'] is True
    for read in c['reads']:
        assert read['kind'] == 'rgba', c['name']
        assert read['bytes'] == (8_294_400 if c.get('motif') == 1920 else 33_177_600), c['name']
    if c.get('video'):
        assert c['projectSettings']['prefer_proxies'] is True
        assert c['videoProbe']['usingProxy'] is True
    if c.get('motif') and not c.get('hidden'):
        assert c['bake'] == dict(phase='ready', done=1828, total=1828), c['name']
    perf = c['measurement']['perf']
    assert c['warnings'] == int(perf['underrun']['lateFrames'] > 0 or perf['underrun']['droppedFrames'] > 0), c['name']
    summary.append(dict(name=c['name'], durationMs=c['durationMs'], elapsedMs=c['elapsedMs'],
        positionUs=c['measurement']['positionUs'], late=perf['underrun']['lateFrames'],
        dropped=perf['underrun']['droppedFrames'], warnings=c['warnings'], reads=len(c['reads']),
        longTasks=len(c['measurement']['longTasks']), canvas=c['measurement']['canvas'],
        targets=c['measurement']['targets'], cache=c['cacheAfter'],
        pressureBefore=c['resourcesBefore']['pressure'], pressureAfter=c['resourcesAfter']['pressure']))
json.dump(summary, open(root / 'verification-summary.json', 'w'), indent=2)
print(json.dumps(summary, indent=2))
