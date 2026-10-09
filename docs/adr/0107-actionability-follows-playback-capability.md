---
status: accepted
---

# Actionability follows playback capability, independently of import work

An imported source could be dragged after its original passed a decoder probe,
then become blocked when its delayed workspace copy entered the queue. Copy
completion changed the path and discarded the successful probe, blocking it
again. The pool also used persisted proxy paths while playback used the engine
resolver, so their answers could disagree.

`resolvePreviewSource` gathers the same live engine setting, component
availability, proxy preference and session capability for both playback and
actionability. `mediaReadiness` converts that resolution plus source availability
into a user-operation verdict. `useImportReadiness` publishes its snapshot to
the pool and a live query to the timeline's drop handler. A job completion alone
cannot grant access, and an outstanding hash, copy or optimization cannot revoke
an already usable source. Standard can use the probed original immediately;
Lite requires a successful original decode or the selected, available proxy.
This is admission to playback, not a promise that every frame will decode:
terminal engine failures invalidate the verdict and permit the existing engine
fallback rules to run.

Preview capabilities belong to source content within a project opening.
`PreviewCapabilities` owns at most two probes, preserves in-flight work across
unrelated summary updates, and retries inconclusive results. Probes needed for
first use may run during playback, still subject to resource admission and
memory pressure. Optional probes obey background-playback policy.

A verified content hash allows a source path to relocate without discarding
decode evidence. Main emits `media:source-relocated` only when the workspace
write-back matches the prior source hash and size. This explicit handoff covers
coalesced summaries that skip the intermediate hash-only state. Missing files,
different content and retired project openings discard evidence and cancel
obsolete probes; late results cannot restore it. This is not a permanent
`ready` latch.

Copy progress remains a separate UI axis: waiting, copying, complete, failed or
cancelled. Native publishes `Copying` only after admission and serializes queue
snapshot publication; the initial renderer query cannot overwrite newer streamed
events. A corner status can coexist with an actionable card or a genuine decode
blocker. Export retains its own artifact and audio preparation gates.

Regression checks cover early admission, queue transitions, content-preserving
handoff, replacement, missing sources, decoder failure, project retirement and
live drop validation. Real-media validation measures first editable and first
submitted frame separately, and checks that ordinary import work never causes
an actionable card to become blocked again.
