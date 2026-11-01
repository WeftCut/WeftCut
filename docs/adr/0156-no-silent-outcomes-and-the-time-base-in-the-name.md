---
status: accepted
---

# No silent outcomes; the time base is in the name

Date: 2026-11-01

## Context

An MCP client sees only what a call answers. The 2026-11 surface audit (122
findings, 13 live runs) found two causes behind most wrong edits that looked
right:

- **Silent outcomes.** Writes that ignored an argument, dropped a value or
  overwrote a file reported success; reads that delivered less than asked
  (effects skipped, a failed waveform shown as pending) looked complete. The
  agent verified against an answer that was true and incomplete.
- **Time names without a clock.** `t_*` held timeline, source or layer-local
  time depending on the tool. `analyze_audio`'s alignment formula was right
  only at rate 1, and an agent cannot tell which clock a bare name means.

Both are cheap to keep out per tool and impossible to keep out by review
alone: the catalog has about 100 tools across TS, Rust, Motif and export.

## Decision

- **A write that would not apply refuses.** Ignoring, dropping or not applying
  any argument is a refusal naming it: an empty patch, a flag call naming no
  flag, a key outside a kind's arm, a `null` where null means nothing, two keys
  that snap onto one frame. A `null` arm is advertised only where it means
  something. A read or render that delivers less than asked refuses, or says
  so in a typed field.
- **A write that must answer before its work finishes says so.**
  `import_media` reserves the `Media/` copy's name when it queues the copy and
  answers that path with `copying: true`, instead of blocking on a large file
  or answering a path that does not exist yet.
- **Every time name carries its base.** `t_*` is timeline-absolute (the owning
  composition's clock), `src_*` source-absolute, `local_*` layer-local; a role
  word follows the base (`t_cut_us`, `t_end_us`); a bare `_us` / `_s` is a
  duration. A result in source time for a layer carries the layer's `mapping`
  (start, source in point, rate, phase), so the agent never derives a formula.
  A tool addressed by media alone answers source time with no mapping
  (`analyze_audio`, `compare_frames`).
- **Renames are breaks** (ADR 0074): an old spelling is refused naming the new
  one. Names stored in project or preset files (`profile_in_us`,
  `keyframe_interval_sec`) keep their spelling until a migration renames them;
  they are the gate's listed exceptions.
- **Each rule has a gate over the whole catalog.** `mcp.no-silent-outcomes`
  sends every optional and nullable field of every write tool alone on a
  fixture project and fails unless state changed or the call refused.
  `mcp.time-base-names` walks every input property and every documented
  result key. Each gate's exceptions are an explicit list with a reason per
  entry.

## Consequences

- A new tool or field fails CI until it refuses, changes state, or is listed
  with its reason; a new time field fails until its name carries a base.
- Agents get more refusals and fewer surprises; every refusal names the fix,
  so a refusal costs one call.
- Tools that run on native compute, the Motif store or export jobs sit in the
  sweep's exception list because a fixture cannot run them; their outcomes are
  covered by their own tests.

Rejected: answering a best effort and reporting it in `adjusted` (the clamp
the UI's drag makes is a refusal over MCP; only the grid snap and a Motif's
content length are echoed); aliases for old time names; blocking
`import_media` until the copy lands.
