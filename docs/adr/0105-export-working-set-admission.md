---
status: accepted
---

# Admit one export working set and lend it to production stages

## Context

Independent encoder, compositor and decoder reservations could each fit the
working allowance while their simultaneous demand could not. An export then
held a sink/worker allocation while waiting for a decoder that could never fit.
A fixed 24-picture dispatch window also rejected 1080p Main10 at the 2304 MiB
memory target (921 MiB working allowance).

## Decision

The existing native resource governor remains the single authority. Metadata
preflight describes up to three execution plans, preferred first. Each sums the
encoder, compositor, bounded Motif producer/capture/transport and peak simultaneous
decode identities. Adjacent clips do not count twice; overlapping clips at
different source phases do. Native decoder demand comes from the same addon
estimator used on open. WebCodecs uses the actual source's coded dimensions.

The governor atomically selects a fitting plan and reserves its memory and native
encoder threads. Worker, decoder, sink and Motif capture/texture claims borrow
from that parent. Memory borrow/return preserves the total; children cannot create capacity
or borrow another renderer's token. Renderer exit returns unused capacity while
live children remain charged until teardown. Native encoding stays serialized
because the encoder sink is a singleton. Encoder thread arguments use the
admitted permit, including when settings change during an export. When the
encoder closes, its CPU threads return to the governor immediately; only the
remaining memory envelope stays reserved until mux.

Waiting exports hold no reservation. Releases, pressure changes and settings
changes wake admission through a native revision/notification pair. A static
minimum exceeding the working allowance fails immediately, before audio/video
production; temporary contention waits with cancellation and a 15-second
deadline. Structured failure reasons select localized recovery copy. Resource
rejections do not offer an unrelated encoder fallback. Ordinary pressure or a
reduced target does not revoke an admitted working set; critical host pressure
still refuses new child allocations.

Known AVC levels can reduce the dispatch window to the level's maximum decoded
picture buffer plus eight pipeline credits (at most the original 24). The
existing sixteen private/reference pictures and 64 MiB context estimate remain
charged. Unknown codec/level keeps 24. This changes buffering only: resolution,
bit depth, frame count, codec and rate control remain the requested values.
The AVC level bounds follow Chromium's H.264 level-limits implementation and
ITU-T H.264 Annex A. The selected window is validated again before decoder open. Motif execution
can likewise reduce its producer from three in-flight frames to one, retaining
enough bytes for every simultaneously visible Motif in a frame.

Preview suspension persists across asynchronous PIXI initialization. Admission
retires the owner's preview Motif GPU caches before reserving the export envelope;
cancellation retires export pools and cancels pending imports as well. Export
finishes audio before reserving video production, so audio cannot deadlock
behind the video envelope. At mux, idle export Motif pools retire and finalization
waits for real child teardown, then shrinks the parent to the existing 64 MiB
stream-copy tail. Mux failure retains encoded files and this tail for retry or
discard (ADR 0104); encoding is not repeated.

## Boundaries and validation

Default memory fractions and user settings are unchanged. This does not redesign
benchmark protocols, preview cache eviction, background scheduling fairness or
crash/restart recovery. Memory estimates are cooperative accounting, not an OS
hard cap. Windows GPU transport requires a real supported Windows host for
end-to-end validation; unit tests enforce parent ownership and delayed-reference
release on all platforms.

Regression gates cover plan arithmetic, owner isolation, cancel/navigation,
pressure/target changes, delayed teardown, low-budget Main10 precision and EOS,
transient occupancy without partial allocation, repeated exports, and mux-only
recovery. Export timing and image conformance are compared to the pre-change
baseline; the full test matrix remains required.
