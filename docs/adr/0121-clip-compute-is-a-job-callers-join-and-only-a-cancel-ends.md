# ADR 0121: Clip compute is a job callers join, and only a cancel ends it

Status: Accepted

Builds on [ADR 0120](0120-compute-a-person-waits-on-has-its-own-admission-lane.md),
whose blocking reasons a queued job reports. The MCP error model, the
diagnostic log and the agent activity stream of
[ADR 0065](0065-agent-view-work-session-and-activity-are-independent.md) are
unchanged; this adds a record beside them.

## Context

`transcribe_clip` and `describe_clip` run for minutes on a long source. Called
through the stdio shim they failed after 60 seconds with "WeftCut is not
running" while the app kept working (#67). The shim now runs tool calls under
an idle window that app progress re-arms, but the app sent no progress, so a
long call still looked dead.

Nothing tied the calls together either. An agent that retried after a timeout
started a second job beside the first, three retries queued three, and a
person pressing Transcribe on the clip an agent was reading started a fourth.
No call could be cancelled, and nothing could tell whether the caller of a
running call was still there. The Activity row of a call that never resolved
stayed running for good.

## Decision

A clip-compute call is a **job** in one main-process registry
(`main/compute/jobs.ts`), shared by the agent's MCP calls and the renderer's.

- **Synchronous calls, with progress.** No new tools and no MCP tasks: the
  call returns the tool's answer when the job ends. While it runs, every
  waiting caller whose request carries a `progressToken` gets
  `notifications/progress` when it attaches, on every phase change and at
  least every 15 seconds, with a growing `progress` and the phase in English
  as `message`.
- **Phases.** Native reports `compute:job_phase` for the job id the host
  injects: queued (with the ADR 0120 reason), extracting, normalizing, loading
  the model, inferring. A job is `queued` with no reason before native has
  said anything, so no job is ever without a phase. There is no terminal
  event; the native call settling is the end.
- **Singleflight.** A call joins the running job with the same key: the tool,
  the source (its content hash; its media id until hashed), the source span
  (the window's offsets into the layer plus the layer's source mapping), and
  every argument that changes the answer, including the engine the host
  injects. A person's press on a clip an agent is transcribing joins that job.
- **Only an explicit cancel cancels.** A caller that cancels (MCP
  `notifications/cancelled`) settles at once and detaches. The job is
  cancelled when no caller is attached any more and at least one of them
  cancelled. The app's cancel button cancels the job for everyone.
- **A disconnect leaves the job running.** The SDK aborts a handler both on
  a cancel and when its transport closes. The app counts the abort as a
  cancel only if the session's transport is still there one microtask later,
  the same rule the shim uses. A caller that went away is not attached but
  cancels nothing: its call ends when the job does, and a retry joins. Its
  Activity row is marked `caller_disconnected` and stays running until then.
- **Every caller settles exactly once**, with the answer, the failure, or
  "cancelled". A cancelled call answers the agent with an `isError` result
  whose code is `cancelled`. The model-file lease is held once per job, from
  the native call's start until the native call settles, even if callers
  were told about a cancel sooner.

The renderer mirrors the registry (`compute_jobs:changed` plus a snapshot
channel). A human call does not know its job id beforehand, because it may
join an agent's job, so it tags the call with a `request_id`. Main strips the
tag before the key and native see it, and the job record lists the tags of
its human callers. A cancelled human run logs a cancelled terminal row at
`info` that closes its op as `Ok`, as an import or export cancel does.

## Considered options

**MCP tasks or a start/poll tool pair.** Rejected for now (#67, D2): clients
support them unevenly, an agent would have to learn a second calling
convention for two tools, and progress over the open call is enough once
the shim stops timing out.

**Cancel on disconnect.** Rejected: a dropped stream, a client restart or a
shim timeout looks like a disconnect. Cancelling then throws away minutes of
work that the retry, sent seconds later, would have joined.

**Match a human run to its job by layer and window.** Rejected: two jobs on
one layer can differ in an argument such as normalization, and a press can
join a job keyed from another layer over the same source. The tag is exact.

## Consequences

- A retry after a timeout, or a second press, costs nothing extra; the Activity
  row and the progress messages say what the job is waiting for.
- A job whose callers have all gone runs to the end and nobody reads its
  answer, though the native caches keep it. That is the price of letting
  retries join.
- An addon without `cancelComputeJob` cancels nothing natively. Callers are
  still answered, and the lease is held until the native call ends.
- The renderer's own in-flight gates are unchanged. They also cover the input
  preflight and the write-back, and an agent's job on another clip must not
  grey out a person's press.
