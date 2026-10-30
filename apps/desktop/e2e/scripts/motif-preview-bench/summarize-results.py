import argparse
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser(description='Validate and summarize completed preview benchmark cases.')
parser.add_argument('files', nargs='*', default=['preview-result.json'])
parser.add_argument('--expect', type=int, default=15, help='Expected completed case count (default: all 15 cases).')
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
    div = {'full': 1, 'half': 2, 'quarter': 4}[c['resolution']]
    before, after = c['reader']['before'], c['reader']['after']
    delta = lambda pick: pick(after) - pick(before)
    lanes = {lane: delta(lambda s: s['reads'][lane]) for lane in ('texture', 'utility')}
    assert after['scaleDiv'] == div, c['name']
    assert delta(lambda s: s['transportFailures']) == 0, c['name']
    assert delta(lambda s: s['misses']) == 0, c['name']
    # Main sees only texture-lane reads; `unavailable` ones fall back to the utility lane.
    for read in c['reads']:
        assert read['kind'] in ('texture', 'unavailable'), c['name']
        assert read['div'] == div, c['name']
    if c.get('motif') and not c.get('hidden'):
        assert sum(lanes.values()) > 0, c['name']
    texture_ms = sorted(r['ms'] for r in c['reads'] if r['kind'] == 'texture')
    if c.get('video'):
        assert c['projectSettings']['prefer_proxies'] is True
        assert c['videoProbe']['usingProxy'] is True
    if c.get('motif') and not c.get('hidden'):
        assert all(b == dict(phase='ready', done=1828, total=1828) for b in c['bake']), c['name']
    perf = c['measurement']['perf']
    assert c['warnings'] == int(perf['underrun']['lateFrames'] > 0 or perf['underrun']['droppedFrames'] > 0), c['name']
    summary.append(dict(name=c['name'], durationMs=c['durationMs'], elapsedMs=c['elapsedMs'],
        positionUs=c['measurement']['positionUs'], late=perf['underrun']['lateFrames'],
        dropped=perf['underrun']['droppedFrames'], warnings=c['warnings'], reads=lanes,
        fallbacks=delta(lambda s: s['fallbacks']), restarts=delta(lambda s: s['restarts']),
        scaleDiv=after['scaleDiv'], stages=after['stages'],
        textureReadMs=texture_ms and dict(p50=texture_ms[len(texture_ms) // 2], p90=texture_ms[len(texture_ms) * 9 // 10]),
        longTasks=len(c['measurement']['longTasks']), canvas=c['measurement']['canvas'],
        targets=c['measurement']['targets'], cache=c['cacheAfter'],
        pressureBefore=c['resourcesBefore']['pressure'], pressureAfter=c['resourcesAfter']['pressure']))
json.dump(summary, open(root / 'verification-summary.json', 'w'), indent=2)
print(json.dumps(summary, indent=2))
