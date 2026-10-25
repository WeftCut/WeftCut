---
status: accepted
---

# The audit checks what has a right answer, and taste is the user's review

Date: 2026-10-25

## Context

From H2 to H6 the audit grew rules about how good a cut is, not only
whether it is correct:
- `bare-talk`, `sparse-beats` and `scene-count`: how dense it is;
- `word-heavy` and `scene-all-words`: pictures against words;
- `still-scenes`: animated scenes against still ones (ADR 0134);
- `scene-share`: how long scenes hide the speaker;
- `overlay-echoes-speech`, `bare-jump-cuts` and `callout-outlives-picture`.

A style's `tokens.pace` tightened the first four.

Each rule came from a failure the bench saw, and each moved the numbers it
counts. The cuts did not get better in step. After the style and bench
rounds of 2026-10-25 (`docs/notes/agent-bench-style-2026-10-25.md`), the
user watched all five cuts and found Opus's overlays the only good ones:
- **The design depends on the model.** It does not depend on the rules it
  is held to.
- **Weaker models meet the counts instead of the idea.** For example, they
  add a sticker to keep a beat every 30 s.
- **The plan's quality follows its reviewer.** It does not follow the
  checks.

## Decision

- **The harness stays light.**
  - One skill drives the agent.
  - The app gives it capabilities and checks that have a right answer.
  - A human's review of the plan and of the cut holds every model to the
    user's taste.
- **The audit keeps only rules with a right answer:**
  - placement: `text-offscreen`, `title-safe`, `motif-off-frame`;
  - readability: the caption rules, the holds, `text-pops`,
    `captions-covered`, `short-clip`;
  - consistency with the style: `undeclared-role`, `role-inconsistency`,
    `token-drift`.
- **These ten rules are removed:**
  - `bare-talk`, `sparse-beats`, `scene-count`;
  - `word-heavy`, `scene-all-words`, `still-scenes`, `scene-share`;
  - `overlay-echoes-speech`, `bare-jump-cuts`, `callout-outlives-picture`.
- **`tokens.pace` is removed.** A TASTE.md that sets it now gets a
  diagnostic, "unknown token group".
- **ADR 0134 is revised.** Its `still-scenes` warning and its scene counting
  are gone. A drawn scene is still opaque, so one on a track above the
  captions still hides them.
- **ADR 0132 is revised.** Its use of `scene-all-words` is gone.

## Consequences

- **Agents get fewer findings to fix, and the user judges more.** A dense
  or sparse cut, or a slideshow, now reaches the user's review unflagged.
- **The removed rules' history** stays in the notes for H2–H6, if a rule
  with a right answer needs to come back.
- **The bench's checklist still has items for density and pictures.** It
  no longer gates on them. The bench becomes a regression check, covering
  whether the flow runs, what it costs, and the audit.
