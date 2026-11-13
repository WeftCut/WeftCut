import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry, LogLevel } from "../ipc";
import { ERROR_STICKY_MS, useLogStore } from "./store";

vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));

let id = 0;
const entry = (level: LogLevel): LogEntry => ({
  id: `e${++id}`, ts: "2026-01-02T03:04:05.000Z", level,
  category: { kind: "Project" }, source: { kind: "System" }, message: `${level} ${id}`,
});
const store = () => useLogStore.getState();

beforeEach(() => {
  // The sticky window is wall-clock: run it on a clock the test moves.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
  useLogStore.setState({ entries: [], unseenErrors: 0, consoleOpen: false, latest: null, latestStickyUntil: 0, ready: false });
});
afterEach(() => { vi.useRealTimers(); });

describe("unseen errors", () => {
  it("counts errors that arrive while the console is closed, and no lower level", () => {
    store().append(entry("error"));
    store().append(entry("warn"));
    store().append(entry("info"));
    store().append(entry("error"));
    expect(store().unseenErrors).toBe(2);
  });

  it("does not count errors the open console is showing", () => {
    store().setConsoleOpen(true);
    store().append(entry("error"));
    expect(store().unseenErrors).toBe(0);
  });

  it("resets on opening the console and counts afresh once it closes", () => {
    store().append(entry("error"));
    store().append(entry("error"));
    store().setConsoleOpen(true);
    expect(store().unseenErrors).toBe(0);
    store().setConsoleOpen(false);
    expect(store().unseenErrors).toBe(0);
    store().append(entry("error"));
    expect(store().unseenErrors).toBe(1);
  });

  it("counts the seeded errors as unseen unless the console is open", () => {
    const seeded = [entry("error"), entry("info"), entry("error")];
    store().seed(seeded);
    expect(store().unseenErrors).toBe(2);
    useLogStore.setState({ unseenErrors: 0, consoleOpen: true });
    store().seed(seeded);
    expect(store().unseenErrors).toBe(0);
  });

  it("clears the count with the log", () => {
    store().append(entry("error"));
    store().clear();
    expect(store().unseenErrors).toBe(0);
  });
});

describe("latest slot", () => {
  it("holds an error against lower levels for the sticky window, then yields", () => {
    const error = entry("error");
    store().append(error);
    store().append(entry("info"));
    expect(store().latest).toBe(error);
    vi.advanceTimersByTime(ERROR_STICKY_MS);
    const info = entry("info");
    store().append(info);
    expect(store().latest).toBe(info);
  });

  it("ends the sticky window when the console opens: the error has been seen", () => {
    store().append(entry("error"));
    store().setConsoleOpen(true);
    const info = entry("info");
    store().append(info);
    expect(store().latest).toBe(info);
  });
});
