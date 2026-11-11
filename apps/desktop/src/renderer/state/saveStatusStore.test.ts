import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaveStatus } from "../../shared/save-status";

const bus = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  pull: null as null | ((status: SaveStatus) => void),
}));
vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    bus.handlers.set(name, handler);
    return () => bus.handlers.delete(name);
  }),
}));
vi.mock("@/bridge/ipc", () => ({
  invoke: vi.fn(() => new Promise((resolve) => { bus.pull = resolve; })),
}));

import { SAVE_STATUS_CHANNEL, SAVE_STATUS_EVENT } from "../../shared/save-status";
import { invoke } from "@/bridge/ipc";
import { useSaveStatusStore, wireSaveStatus } from "./saveStatusStore";

const failing = (revision: number): SaveStatus => ({
  state: "failing", revision, since: "2026-01-02T03:04:05.000Z", last_saved_at: null,
  code: "ENOSPC", path: "/home/u/Demo/project.json", dir: "/home/u/Demo",
});
const push = (status: SaveStatus) => bus.handlers.get(SAVE_STATUS_EVENT)!({ payload: status });

afterEach(() => {
  useSaveStatusStore.setState({ status: { state: "ok", revision: 0 } });
  bus.handlers.clear();
  bus.pull = null;
});

describe("wireSaveStatus", () => {
  it("takes the pulled state when it is the newest, then every newer push", async () => {
    const wiring = wireSaveStatus();
    await vi.waitFor(() => expect(bus.pull).not.toBeNull());
    expect(invoke).toHaveBeenCalledWith(SAVE_STATUS_CHANNEL);
    bus.pull!(failing(3));
    const stop = await wiring;
    expect(useSaveStatusStore.getState().status).toEqual(failing(3));
    push({ state: "ok", revision: 4 });
    expect(useSaveStatusStore.getState().status).toEqual({ state: "ok", revision: 4 });
    stop();
    expect(bus.handlers.has(SAVE_STATUS_EVENT)).toBe(false);
  });

  it("listens before it pulls, and a pull answering late cannot roll a newer push back", async () => {
    const wiring = wireSaveStatus();
    await vi.waitFor(() => expect(bus.pull).not.toBeNull());
    push(failing(5));
    bus.pull!({ state: "ok", revision: 4 });
    const stop = await wiring;
    expect(useSaveStatusStore.getState().status).toEqual(failing(5));
    stop();
  });
});
