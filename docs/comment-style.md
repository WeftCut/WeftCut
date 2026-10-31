# Comment style

A comment tells the reader something the code cannot, and stays true as the code
changes.

## Evergreen, with one exception

A comment reads as if written today: no history, dates, commit hashes, phase
numbers, per-version changelogs or superseded approaches. Those live in git, an
ADR or `docs/notes/`.

The exception is the **landmine**: when the history *is* the constraint ("undo
this and X deadlocks"), keep that one fact inline, compressed. Test: if a
maintainer deleted the comment and "fixed" the code, would something break? If
yes, it stays.

## What a comment carries

1. **Summary** one level above the code — only when the name and signature don't
   already say it.
2. **The non-obvious why** — a counter-intuitive choice, constraint or invariant.
3. **Landmines** — "must stay identical to its twin", "this ordering is
   load-bearing", "no `flush()` here: it deadlocks against held pool slots".
4. **Pointers** — to the ADR, doc section, golden test or twin file holding the
   full story. Prefer a pointer over inlining rationale.

Never: narration of how, paraphrase of the next line, rejected approaches
(unless re-introducing one re-introduces a bug — then it is a one-line landmine).

## One home per fact

Rationale lives at the most specific site that owns it — the constant, function
or field. A file header (`//!` in Rust, top-of-file in TS) is navigation only:
what the module owns, what it does not, and a pointer. Don't repeat a constant's
why in the header.

## Collapse changelogs

A "v0 → v1 → v2" list becomes the rule plus what is load-bearing now:

```rust
/// Bump whenever the proxy ffmpeg args change in a way that affects playback,
/// scrub or color: an older stored version is invalidated and re-encoded.
///
/// Current format: H.264 capped at 2160p, `-bf 0` (PTS=DTS — keeps the
/// auto-pause last-frame snap correct), short fixed GOP. See ADR NNNN.
pub const PROXY_FORMAT_VERSION: u32 = 7;
```

The `-bf 0` note survives as a landmine; the per-version diffs go to the ADRs.
