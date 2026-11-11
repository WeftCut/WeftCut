import { create } from "zustand";
import { listen, type UnlistenFn } from "@/bridge/events";

import { projectHistoryView, type HistoryStackView } from "../ipc";

/// Renderer mirror of the FULL edit stack (`project_history_view`) — rows and
/// checkpoints, everything the History Panel draws.
///
/// Deliberately separate from `projectStore`: folding `ops` into
/// `ProjectSummary.history` would strap up to 200 entries (with their
/// `entity_labels`) onto the full-summary refetch that runs on EVERY edit,
/// whether the panel is open or not. Here the Panel owns the subscription, so
/// a closed Panel issues no IPC at all (spec decision 5).

export interface HistoryStoreState {
  view: HistoryStackView | null;
  /// True once the first fetch has settled — the Panel's only cue to draw a
  /// placeholder rather than a bare list on its very first render.
  ///
  /// `view === null` therefore means exactly one thing: the seed fetch has not
  /// landed yet. There is no "fetched but empty" state to tell it apart from —
  /// the read is served straight off a live actor whose stack always holds at
  /// least the `Initial` seed.
  ready: boolean;
}

interface HistoryStoreActions {
  /// Non-nullable on purpose: `null` is reachable only through `reset()`, which
  /// means "not fetched", and nothing else can put the store back there.
  apply: (view: HistoryStackView) => void;
  /// Back to the pre-fetch state, so a reopened Panel never flashes the stack
  /// as it stood when it was last closed.
  reset: () => void;
}

export const useHistoryStore = create<HistoryStoreState & HistoryStoreActions>(
  (set) => ({
    view: null,
    ready: false,
    apply: (view) => set({ view, ready: true }),
    reset: () => set({ view: null, ready: false }),
  }),
);

/// The Panel's reads: one fetch in flight, and at most one more queued behind
/// it however many requests arrive meanwhile. A queued fetch starts after every
/// request it stands for, so it reads their state; the view is rebuilt in main
/// on every read, so a multi-commit edit (an auto-paired add is three commits)
/// costs two builds, not one per commit. Fetches run strictly one after
/// another, so every answer is at least as new as the one before it and each is
/// applied as it lands.
class HistoryReads {
  private current: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private stopped = false;

  /// Settles once a fetch that started after this call has applied (or
  /// failed). Never rejects.
  request(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // Checked before `current`: a queued fetch that has not started yet still
    // reads everything up to now.
    if (this.queued) return this.queued;
    if (!this.current) return this.start();
    return (this.queued = this.current.then(() => {
      this.queued = null;
      return this.start();
    }));
  }

  /// Teardown: nothing pending applies and nothing new is fetched.
  stop(): void {
    this.stopped = true;
  }

  private start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const fetch = this.fetchOnce().finally(() => {
      if (this.current === fetch) this.current = null;
    });
    this.current = fetch;
    return fetch;
  }

  /// A failure here drives NO Panel state. `project_history_view` routes to a
  /// read that returns `actor.historyView(cap)` off a live actor and cannot
  /// refuse, so there is no pre-workspace / no-project branch to render — a
  /// "couldn't load" state would be one no test could ever reach.
  ///
  /// It is still caught, because the IPC TRANSPORT can fail even when the
  /// handler cannot (a torn-down main process, a serialization error). Every
  /// caller either discards the request (the event listener) or awaits it from
  /// a click handler, so an escaping rejection would be an unhandled one. The
  /// last-known view stays on screen instead: stale rows are recoverable — the
  /// next `project:changed` refetches — where a thrown renderer is not.
  private async fetchOnce(): Promise<void> {
    try {
      const view = await projectHistoryView();
      if (!this.stopped) useHistoryStore.getState().apply(view);
    } catch (err) {
      if (!this.stopped) console.warn("[historyStore] history view fetch failed; keeping the last view", err);
    }
  }
}

/// Non-null only between `wireHistoryStore` and its teardown, i.e. only while
/// the Panel is open. Every fetch path goes through it, so "closed Panel issues
/// no IPC" is enforced in ONE place rather than at each call site.
let reads: HistoryReads | null = null;

function fetchView(): Promise<void> {
  return reads?.request() ?? Promise.resolve();
}

/// Explicit refetch for the actions that change the view WITHOUT emitting
/// `project:changed` — checkpoint create and delete both change no project
/// state, so nothing broadcasts and this store would otherwise never hear
/// about them. No-op while the Panel is closed.
export async function refreshHistoryView(): Promise<void> {
  await fetchView();
}

/// One-shot mount wiring: subscribe to `project:changed`, then seed. Returns
/// the teardown the Panel stores and invokes on unmount.
///
/// Subscribe BEFORE the seed fetch, for the reason `wireProjectStore`
/// documents: an event emitted between the seed resolving and the listener
/// registering would be lost, and the stack would sit stale until some
/// unrelated later edit. An event landing DURING the seed queues one fetch
/// behind it.
export async function wireHistoryStore(): Promise<UnlistenFn> {
  const mine = new HistoryReads();
  reads = mine;
  const unlisten = await listen("project:changed", () => {
    void fetchView();
  });
  await fetchView();
  return () => {
    mine.stop();
    unlisten();
    // Identity guard: a stale teardown from an old mount (StrictMode's
    // double-invoke, HMR) must neither disarm a newer mount's reads nor wipe
    // the stack it has already fetched.
    if (reads !== mine) return;
    reads = null;
    useHistoryStore.getState().reset();
  };
}

// ===== Atomic selector helpers ============================================

export const useHistoryView = (): HistoryStackView | null =>
  useHistoryStore((s) => s.view);

export const useHistoryReady = (): boolean => useHistoryStore((s) => s.ready);
