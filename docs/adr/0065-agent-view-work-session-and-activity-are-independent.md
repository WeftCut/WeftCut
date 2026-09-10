---
status: accepted
---

# Agent view, work session and activity are independent

Opening the standalone agent panel exposed a coupling inherited from its earlier
agent-mode-only layout: manual entry created a work session and checkpoint, while
returning to the editor ended work and unlocked history. The panel also rebuilt
its transcript from diagnostic log text and removed time ranges on restore,
which could hide reads and failures that had not been undone.

The renderer owns view selection. Manual entry and exit change only the layout.
The main-owned `AgentActivityService` owns one active work session per project
opening, identified by a UUID and the initiating MCP connection UUID. Beginning
work creates one checkpoint and auto-enters agent view once. A repeat from the
same connection returns the session without changing layout; another connection
cannot replace it. Other clients can still make ordinary calls outside that
session.

`end_agent_session`, local end and definite transport close end the work session
and release only its owned undo lock. The user has an independent unlock action.
There is no idle timeout. Ending work does not switch views, cancel computation,
disconnect clients or prohibit subsequent calls. Call attribution is captured on
entry and survives a session ending while the call is still running. Project
replacement resets activity; late results from the old opening cannot populate
the new panel. This is display isolation, not an asynchronous write barrier.

The MCP request funnel feeds a separate structured activity stream as well as
the existing diagnostic decorator. `AsyncLocalStorage` carries call identity to
synchronous actor commits after awaits. Activity stores the actual history IDs,
localized operation labels and object names, execution outcome and duration;
bounded, redacted arguments remain optional technical detail. Restore explicitly
links its history ID even though its change notification has a different ID.
History keeps runtime provenance on snapshots and checkpoints so restore,
undo/redo and branch replacement can distinguish applied and reverted effects.
Unrecorded changes receive no invented history association. IDs beyond the
4000-operation provenance horizon become unknown, never falsely reverted.

Retain the latest 1000 completed activities plus every running activity. Sessions
without retained activities are dropped after ending. This budget is independent
of diagnostic logs, and the UI states when records were truncated. Activity is
not persisted or recovered from JSONL. Main batches deltas by microtask, with a
project-opening UUID and monotonically increasing revision. The renderer merges
matching deltas and repairs gaps with a snapshot; late snapshots cannot overwrite
newer state. A low-frequency reconciliation repairs missed notifications.

Both layouts use one agent panel and one store for filter, expansion and scroll
anchors. Quick successful reads fold together; slow calls, writes and failures
remain visible individually. Current sessions open by default; ended sessions
with running tasks remain open. Checkpoint restore is an explicit action gated
by live checkpoint availability, lock state and pending restore. Object location
is available only in the editor; agent view remains for watching the preview.
The editor's agent-running indicator also reads structured activity.

The MCP host exposes listening availability and registered connection metadata
(client name/version and last request). Registration is not proof that a client
process is online, and no heartbeat is introduced. Connection settings reuse the
existing settings section. Legacy native session-slot APIs remain for binary
compatibility but are no longer consulted or updated by the desktop UI/MCP host.

Validation includes overlapping asynchronous attribution, owned lock release,
disconnect with running work, project replacement, bounded retention and details,
restore/undo/redo provenance, delta reconciliation and shared UI state. Electron
tests exercise both layouts and two real SDK clients through the HTTP transport.
