// The editor's companion bridge against a recorded main: it attaches only once
// it can hear main, watches the player only while main's demand says a page is
// open, and obeys controls addressed to its own token.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_ATTACH,
  COMPANION_CONTROL_EVENT,
  COMPANION_DEMAND_EVENT,
  COMPANION_DETACH,
  COMPANION_TRANSPORT,
} from "../../shared/companion";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<[string, Record<string, unknown> | undefined]>,
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  /** What main answers the attach with. */
  attachReply: { demand: { watch: false } } as { demand: { watch: boolean } },
  play: vi.fn(),
  pause: vi.fn(),
}));
vi.mock("../bridge/ipc", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    mocks.calls.push([cmd, args]);
    // The attach is answered only once both listeners exist, as main relies on.
    if (cmd === COMPANION_ATTACH) {
      expect([...mocks.listeners.keys()].sort()).toEqual([COMPANION_CONTROL_EVENT, COMPANION_DEMAND_EVENT].sort());
      return mocks.attachReply;
    }
    return null;
  }),
}));
vi.mock("../bridge/events", () => ({
  listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => {
    mocks.listeners.set(name, fn);
    return () => { mocks.listeners.delete(name); };
  }),
}));
vi.mock("../state/playbackStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/playbackStore")>()),
  transportPlay: mocks.play,
  transportPause: mocks.pause,
}));

import { installCompanionBridge, TRANSPORT_PUSH_MS } from "./companionBridge";
import { setPlayheadTimeUs } from "../state/playheadStore";

const sentOn = (cmd: string) => mocks.calls.filter(([c]) => c === cmd).map(([, a]) => a);
const tokenOf = () => sentOn(COMPANION_ATTACH)[0]!.token as string;
const tell = (event: string, payload: unknown) => mocks.listeners.get(event)!({ payload });

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.listeners.clear();
  mocks.attachReply = { demand: { watch: false } };
  mocks.play.mockReset();
  mocks.pause.mockReset();
  setPlayheadTimeUs(0);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe("installCompanionBridge", () => {
  it("pushes no transport while no page watches, and does once one does", async () => {
    const dispose = installCompanionBridge(() => {});
    await vi.waitFor(() => expect(sentOn(COMPANION_ATTACH)).toHaveLength(1));
    setPlayheadTimeUs(1_000_000);
    vi.advanceTimersByTime(TRANSPORT_PUSH_MS * 2);
    expect(sentOn(COMPANION_TRANSPORT)).toEqual([]);

    tell(COMPANION_DEMAND_EVENT, { token: tokenOf(), watch: true });
    expect(sentOn(COMPANION_TRANSPORT)).toEqual([{ token: tokenOf(), t_us: 1_000_000, playing: false }]);
    // Moves inside one interval are folded; the last of them lands.
    setPlayheadTimeUs(1_100_000);
    setPlayheadTimeUs(1_200_000);
    vi.advanceTimersByTime(TRANSPORT_PUSH_MS);
    expect(sentOn(COMPANION_TRANSPORT).at(-1)).toMatchObject({ t_us: 1_200_000 });

    tell(COMPANION_DEMAND_EVENT, { token: tokenOf(), watch: false });
    const pushed = sentOn(COMPANION_TRANSPORT).length;
    setPlayheadTimeUs(2_000_000);
    vi.advanceTimersByTime(TRANSPORT_PUSH_MS * 2);
    expect(sentOn(COMPANION_TRANSPORT)).toHaveLength(pushed);
    dispose();
  });

  it("watches from the attach reply when a page was already open", async () => {
    mocks.attachReply = { demand: { watch: true } };
    const dispose = installCompanionBridge(() => {});
    await vi.waitFor(() => expect(sentOn(COMPANION_TRANSPORT)).toHaveLength(1));
    dispose();
  });

  it("obeys controls for its own token only", async () => {
    const seeks: number[] = [];
    const dispose = installCompanionBridge((t) => { seeks.push(t); });
    await vi.waitFor(() => expect(sentOn(COMPANION_ATTACH)).toHaveLength(1));
    tell(COMPANION_CONTROL_EVENT, { token: "someone-else", action: "play" });
    tell(COMPANION_CONTROL_EVENT, { token: tokenOf(), action: "play" });
    tell(COMPANION_CONTROL_EVENT, { token: tokenOf(), action: "pause" });
    tell(COMPANION_CONTROL_EVENT, { token: tokenOf(), action: "seek", t_us: 3_000_000 });
    expect(mocks.play).toHaveBeenCalledTimes(1);
    expect(mocks.pause).toHaveBeenCalledTimes(1);
    expect(seeks).toEqual([3_000_000]);
    dispose();
  });

  it("detaches with the token it attached with, and stops watching", async () => {
    mocks.attachReply = { demand: { watch: true } };
    const dispose = installCompanionBridge(() => {});
    await vi.waitFor(() => expect(sentOn(COMPANION_TRANSPORT)).toHaveLength(1));
    dispose();
    expect(sentOn(COMPANION_DETACH)).toEqual([{ token: tokenOf() }]);
    setPlayheadTimeUs(5_000_000);
    vi.advanceTimersByTime(TRANSPORT_PUSH_MS * 2);
    expect(sentOn(COMPANION_TRANSPORT)).toHaveLength(1);
  });
});
