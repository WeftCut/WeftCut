# Edit-latency diagnosis — 2026-10-13

Post-drag stalls on a real project, found with the
[edit-latency probes](../edit-latency-diagnostics.md).

**Environment.** Warm project copy: 287 markers, 62 layers (61 Motifs), dev
renderer, four real drags per capture.

| Measurement | Before | After |
| --- | --- | --- |
| Refresh through two rAF opportunities (CPU profiling on) | 280–301 ms | 68–72 ms |
| Largest rAF gap | 183–200 ms | ~50 ms |
| Autosave timer lateness past the 500 ms debounce | 1157–1181 ms | 0.1–6.1 ms |
| Actual serialize + write | 1.7–2.2 ms | 1.5–1.7 ms |

Production E2E build, same project: 24–28 ms refresh, 16.8 ms max rAF gap.

## Findings

- Saving was never the cost (≤ 2.2 ms); slowing or batching autosave further
  would not help. Lateness was main-loop starvation.
- Main: 5.72 s over four edits in `MotifWorkspace.list` (sync directory reads
  and hashes) because the Motif frame-preparation service (since removed)
  requested the catalog on every project edit. Catalog hydration belongs to
  startup and Motif change events only — do not re-add a per-edit catalog read.
- Renderer: whole-project subscriptions and identity churn. Fixed by a shared
  refresh publisher, identity-preserving IPC snapshot branches, the timeline
  subscribing to its resolved clock, memoized marker rows/glyphs, and
  `useImportReadiness` depending on media changes instead of every summary.

Synthetic Vitest probes at 5,000 layers still show ~17 ms structured clone and
~60 ms history projection per snapshot; full-snapshot cost is tracked in
[issue #63](https://github.com/WeftCut/WeftCut/issues/63).
