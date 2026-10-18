# ADR 0120: Compute a person waits on has its own admission lane

Status: Accepted

Refines the native admission of
[ADR 0101](0101-cross-platform-application-resource-authority.md). The
ledger, pressure signal, export finalization priority and lease lifetime are
unchanged.

## Context

Transcribing a clip slices its audio and may normalize it; describing a clip
samples frames. All three are ffmpeg children, and they took the background
gate that media derivatives use: a background claim with no time limit. That
claim is refused under memory pressure, during playback unless background
processing during playback is on, while the background job cap is full, and
while the CPU/memory budget is full.

On a 36-minute HEVC source a full proxy was being generated when
`transcribe_clip` and `describe_clip` arrived (#67). With the default cap of
one background job, both waited behind the proxy with no limit, the model
never loaded, and nothing said why: which rule had closed admission was not
logged. Work someone had just asked for was queued behind speculative work
nobody was waiting on.

## Decision

User-initiated clip compute (the transcription audio slice and
normalization, and description frame sampling) is admitted through a
**user-compute lane**, `resources::user_compute`.

- It is not held back by the background job cap or by playback. It is still
  refused under memory pressure, while an admitted export waits to finish,
  and while the CPU/memory budget is full. It claims the full CPU limit, as
  interactive work does, with the usual task-thread count and the same
  working-memory charge as a derivative.
- Running derivatives are never interrupted. While a user-compute claim is
  waiting, no new background claim is admitted, so freed capacity goes to it
  rather than to the next queued derivative.
- It waits at most 60 seconds. It then fails with a
  `resource-capacity-exceeded:` message naming the rule still blocking it:
  memory pressure, a finishing export, or the budget, with how many leases
  hold the budget and how many of them are background processing such as
  proxy generation. The blocking reason (`memory`, `finalization`,
  `budget`) is reported to an observer when the claim first waits and
  whenever it changes, so a queued job can show why it is queued.
- Each admission is logged with its queue time, the reason and an admission
  snapshot: at debug level when admitted at once, info when it waited or was
  cancelled, warn when refused.

Derivatives stay on the background gate.

## Considered options

**Use interactive admission and its 15-second limit.** Rejected: interactive
admission is sized for a frame or an export working set that a draining
derivative frees within seconds. A clip computation behind a full transcode,
a pressure hysteresis cycle or an export's mux would routinely fail at
15 seconds, and interactive waiting does not hold background work back, so
the next derivative could take the capacity first.

**Pause or kill the running proxy.** Rejected: a proxy of a long source can
take many minutes and the derivative cache has no resume, so stopping it
throws that work away and restarts it later. It would also make one lane
able to revoke another's admitted lease, which the authority never does.

**Wait without a limit, as background work does.** Rejected: that is the
reported failure. A request that cannot start must answer with its cause.

## Consequences

- With one background job running, user compute normally starts at once:
  background claims leave a CPU slot free, which this lane may take. It
  waits only when pressure, a finishing export or a genuinely full budget
  blocks it, and then for at most 60 seconds.
- Queued derivatives start later while a person is waiting on compute; they
  resume as soon as that claim is admitted, refused or cancelled.
- Frame sampling holds one admission for all its frames rather than one per
  frame, so background work cannot slip in between frames.
- The audio slice seeks in two stages: a coarse input-side seek to a few
  seconds before the in-point, then an exact output-side seek for the rest.
  A window deep into a long file no longer decodes from the start, and the
  output, and so its cache key, is the same window as before.
