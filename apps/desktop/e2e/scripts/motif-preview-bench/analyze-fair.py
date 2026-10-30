import argparse
import json
import math
import os
import re
from pathlib import Path

parser = argparse.ArgumentParser(description='Renderer main-thread occupancy per lane in the fair comparison trace.')
parser.add_argument('--directory', type=Path, default=Path(os.environ.get('WEFTCUT_MOTIF_BENCH_DIR',
    Path(__file__).resolve().parents[3] / 'reports/motif-preview-bench')))
root = parser.parse_args().directory.resolve()
events = json.load(open(root / '.private/fair-trace.json'))['traceEvents']

marks = {}
for e in events:
    match = re.fullmatch(r'fair:([a-z0-9]+@\d):([a-z]+):(-?\d+):(start|end)', e.get('name', ''))
    if match:
        combo, content, round_, side = match.groups()
        marks.setdefault((combo, content, int(round_)), {}).setdefault(side, e)

tasks_by_thread = {}
for e in events:
    if e.get('ph') == 'X' and e.get('name') == 'ThreadControllerImpl::RunTask':
        tasks_by_thread.setdefault((e['pid'], e['tid']), []).append(e)

def percentile(values, q):
    return sorted(values)[max(0, math.ceil(len(values) * q) - 1)] if values else None

rows = []
for (combo, content, round_), pair in marks.items():
    if round_ < 0 or 'start' not in pair or 'end' not in pair:
        continue
    start, end = pair['start'], pair['end']
    tasks = [t for t in tasks_by_thread.get((start['pid'], start['tid']), []) if t['ts'] < end['ts'] and t['ts'] + t['dur'] > start['ts']]
    clipped = [max(0, min(t['ts'] + t['dur'], end['ts']) - max(t['ts'], start['ts'])) / 1000 for t in tasks]
    rows.append(dict(combo=combo, content=content, round=round_, occupiedMs=sum(clipped), largestTaskMs=max(clipped, default=0)))

summary = []
for key in sorted({(r['combo'], r['content']) for r in rows}):
    selected = [r for r in rows if (r['combo'], r['content']) == key]
    summary.append(dict(combo=key[0], content=key[1], count=len(selected),
        medianOccupiedMs=percentile([r['occupiedMs'] for r in selected], .5),
        p95OccupiedMs=percentile([r['occupiedMs'] for r in selected], .95),
        medianLargestTaskMs=percentile([r['largestTaskMs'] for r in selected], .5)))
json.dump(dict(summary=summary, samples=rows,
    definition='Outer ThreadControllerImpl::RunTask slices on the page main thread, clipped to request start through bitmap available; includes IPC deserialization and preload work.'),
    open(root / 'fair-thread-result.json', 'w'), indent=2)
for s in summary:
    print(f"{s['combo']:6} {s['content']:8} n={s['count']:3} occupied p50={s['medianOccupiedMs']:.2f} p95={s['p95OccupiedMs']:.2f} largest={s['medianLargestTaskMs']:.2f}")
