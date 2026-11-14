import { create } from "zustand";
import { listen, type UnlistenFn } from "@/bridge/events";
import { LOG_EVENTS, logList, type LogEntry } from "../ipc";

/// Frontend mirror of the backend log ring. Capped at 1000 entries to
/// match the Rust ring. Seeded on mount via `log_list`; live-updated via
/// the `log:entry` backend event.
///
/// Consumers: the status bar reads `latest` / `unseenErrors`; the console
/// filters `entries` itself and reports its own open state (`setConsoleOpen`).
///
/// Pre-workspace: backend bus is `None`, so `log_list` returns `[]` and
/// no `log:entry` events fire. The store sits idle until the user opens
/// a workspace.

const RING_CAP = 1000;

/// Latest-error sticky window: once an Error lands, the bar's latest
/// slot resists overwrite by lower-severity entries for this many ms.
/// Acknowledged when the log console is opened.
export const ERROR_STICKY_MS = 10_000;

export interface LogStoreState {
  entries: LogEntry[];
  /// Errors that arrived while the console was closed, since it was last
  /// opened. The console being open is seeing them, so none count then.
  unseenErrors: number;
  consoleOpen: boolean;
  /// The last entry shown in the bar's "latest" slot. May lag `entries[0]`
  /// when an error is sticky.
  latest: LogEntry | null;
  /// Wall-clock ms at which the sticky-on-error window for `latest`
  /// expires. `0` when not sticky.
  latestStickyUntil: number;
  /// True after the initial `log_list` seed + subscription is wired.
  ready: boolean;
}

interface LogStoreActions {
  append: (e: LogEntry) => void;
  seed: (initial: LogEntry[]) => void;
  clear: () => void;
  /// The console mounts and unmounts through this; opening it sees every error
  /// so far and ends the sticky window.
  setConsoleOpen: (open: boolean) => void;
}

export const useLogStore = create<LogStoreState & LogStoreActions>(
  (set, get) => ({
    entries: [],
    unseenErrors: 0,
    consoleOpen: false,
    latest: null,
    latestStickyUntil: 0,
    ready: false,

    append: (e) =>
      set((s) => {
        const next = [e, ...s.entries];
        if (next.length > RING_CAP) next.length = RING_CAP;

        const now = Date.now();
        const errorIncoming = e.level === "error";
        const unseenErrors = s.unseenErrors + (errorIncoming && !s.consoleOpen ? 1 : 0);

        // Latest-slot policy: errors always win; otherwise yield only when
        // the prior sticky window has expired. Trace/debug never replace a
        // visible entry — they go straight into entries[] for the console.
        let latest = s.latest;
        let latestStickyUntil = s.latestStickyUntil;
        const wouldShow = e.level !== "trace" && e.level !== "debug";
        if (errorIncoming) {
          latest = e;
          latestStickyUntil = now + ERROR_STICKY_MS;
        } else if (wouldShow && now >= s.latestStickyUntil) {
          latest = e;
        }

        return { entries: next, unseenErrors, latest, latestStickyUntil };
      }),

    seed: (initial) => {
      // initial is in backend order (oldest first in the ring). Reverse so
      // entries[0] is newest, matching `append`'s prepend pattern.
      const reversed = [...initial].reverse();
      // The console has never shown these in this window.
      const unseenErrors = get().consoleOpen ? 0 : reversed.filter((e) => e.level === "error").length;
      const latest = reversed.find(
        (e) => e.level !== "trace" && e.level !== "debug",
      ) ?? null;
      set({ entries: reversed, unseenErrors, latest, ready: true });
    },

    clear: () =>
      set({
        entries: [],
        unseenErrors: 0,
        latest: null,
        latestStickyUntil: 0,
      }),

    setConsoleOpen: (open) =>
      set(open ? { consoleOpen: true, unseenErrors: 0, latestStickyUntil: 0 } : { consoleOpen: false }),
  }),
);

/// One-shot mount wiring: seed from `log_list`, then subscribe to
/// `log:entry`. Returns a teardown function.
///
/// NOT idempotent: `listen` registers an ADDITIONAL `log:entry` handler per
/// call, so calling twice without running the first teardown double-appends
/// every entry. The App calls it once from a top-level `useEffect`.
export async function wireLogStream(): Promise<UnlistenFn> {
  try {
    const initial = await logList();
    useLogStore.getState().seed(initial);
  } catch (e) {
    // Pre-workspace `log_list` returns []; only unexpected failures
    // land here. Don't trigger an error entry because the log isn't
    // wired yet.
    console.warn("logList seed failed:", e);
  }
  return await listen<LogEntry>(LOG_EVENTS.entry, (event) => {
    useLogStore.getState().append(event.payload);
  });
}
