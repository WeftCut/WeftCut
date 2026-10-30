import json
import math
import re
import os
import argparse
from pathlib import Path

parser = argparse.ArgumentParser(description='Summarize renderer main-thread tasks in the local transport trace.')
parser.add_argument('--directory', type=Path, default=Path(os.environ.get('WEFTCUT_MOTIF_BENCH_DIR',
    Path(__file__).resolve().parents[3] / 'reports/motif-preview-bench')))
root = parser.parse_args().directory.resolve()
events = json.load(open(root / '.private/transport-trace.json'))['traceEvents']
marks = {}
for e in events:
    match = re.fullmatch(r'bench:([abcd]):(\d+):(start|end)', e.get('name', ''))
    if match:
        mode, round_, side = match.groups()
        marks.setdefault((mode, int(round_)), {})[side] = e

def percentile(values, q):
    return sorted(values)[max(0, math.ceil(len(values) * q)-1)]

rows = []
for (mode, round_), pair in marks.items():
    if 'start' not in pair or 'end' not in pair:
        continue
    start, end = pair['start'], pair['end']
    tasks = [e for e in events if e.get('ph') == 'X'
             and e.get('name') == 'ThreadControllerImpl::RunTask'
             and e.get('pid') == start['pid'] and e.get('tid') == start['tid']
             and e['ts'] < end['ts'] and e['ts'] + e['dur'] > start['ts']]
    clipped = [max(0, min(t['ts']+t['dur'], end['ts']) - max(t['ts'], start['ts']))/1000 for t in tasks]
    rows.append(dict(mode=mode, round=round_, occupiedMs=sum(clipped), largestTaskMs=max(clipped, default=0)))

summary = []
for mode in 'abcd':
    selected = [r for r in rows if r['mode'] == mode]
    summary.append(dict(mode=mode, count=len(selected),
        medianOccupiedMs=percentile([r['occupiedMs'] for r in selected], .5),
        p95OccupiedMs=percentile([r['occupiedMs'] for r in selected], .95),
        medianLargestTaskMs=percentile([r['largestTaskMs'] for r in selected], .5),
        p95LargestTaskMs=percentile([r['largestTaskMs'] for r in selected], .95)))
result = dict(summary=summary, samples=rows,
              definition='Outer ThreadControllerImpl::RunTask slices on CrRendererMain, clipped to request-start through bitmap-available; includes IPC deserialization. Does not include subsequent canvas draw/read.')
json.dump(result, open(root / 'transport-thread-result.json', 'w'), indent=2)
print(json.dumps(summary, indent=2))
