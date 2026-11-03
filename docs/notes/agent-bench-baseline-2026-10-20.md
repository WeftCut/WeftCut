# Agent bench baseline — 2026-10-20

What three Claude models did with WeftCut before any craft rule, recipe or
style existed. Source of the first `craft/` rules (`src/shared/craft.ts`).

## Environment

- Skill: main's bundle at `e3c184dc` (no craft/recipes/Motif scope rule).
  Claude Code 2.1.304 headless, isolated workdir, MCP over an ssh tunnel to
  the Windows bench host (i5-13400, RTX 3050).
- Fixtures: `talking-head-interview` (2:31) and `explainer-memory` (3:35),
  H.264/AAC. Six tasks × Opus/Sonnet/Haiku 5.5, two batches of 18 runs.
  Results under `apps/desktop/bench/results/2026-10-20T*`/`2026-10-21T01*`
  (local). Cost ≈ $10 per batch (Opus ~70%).

## Findings

- **Intent checklist** (lenient, "was it done"): Opus 43/43, Sonnet 42/43,
  Haiku 38/43. Misses were engagement, not quality: Haiku never found the app
  when the prompt did not name WeftCut (repeated), and once edited a **new**
  project instead of the open one.
- **Look converges on tool defaults for every model**: system sans, white,
  bold, black outline, no plate, no entrance/exit (`intro`/`outro` null in all
  runs). Titles centred over the speaker or at top; explainer titles held
  2.5–3.0 s; lower thirds 4.0–6.9 s. Style is decided by tool defaults, so
  style tokens as defaults (construction) is the lever with the most reach.
- **Captions** are the transcription segmentation passed through: up to 68–80
  chars per cue, minimum 0.42 s; no model restyled them.
- **Cuts**: `remove_pauses` gives identical results across models and runs (a
  tool default equalises models). Free-form tightening diverges: Sonnet left
  129 clips, median 0.84 s, shortest 0.28 s — a jump-cut stutter.
- **Motifs**: frame-sized canvases in 5 of 6 packages and positions baked into
  the page or props in 4 of 6; every fix round resent the whole `index.html`
  (5–10 KB). After the Motif scope rule: element-sized callouts in 6 of 6, no
  mixed-purpose packages, positions baked in 1 of 6, `edits` of 158–564 chars.
- **`preview_motif` cropped instead of scaling** a smaller preview of a
  frame-sized page; Haiku spent ~30 turns debugging a Motif that was fine
  (fixed: preview scales the whole canvas; motif-workspaces.md § Review,
  publication and export).
- **Run to run**, divergence lives where model divergence does — in what tools
  leave to the agent (caption segmentation and style, text placement and
  holds, Motif route, process steps), not in what a tool decides.

## Rules that came from it

Title hold ≥ 3 s; lower-third hold for two lines; text enters and exits;
captions ≤ 42 chars per line, ≤ 2 lines, cue 1.2–6 s; no clip under 1 s
without a reason; a Motif's canvas is the element's bounds and its position
comes from the layer. The skill and `initialize` instructions now say the job
is the project already open in the app.
