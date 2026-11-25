// @vitest-environment jsdom
//
// The window's side of a file-open request (ADR 0181): a request is taken from
// main only while the surface can open it, each ping takes again, and one
// taken is always handled, even by a surface unmounting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const events = vi.hoisted(() => ({ ping: null as (() => void) | null }));
vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (_event: string, handler: () => void) => {
    events.ping = handler;
    return () => { events.ping = null };
  }),
}));

import { useFileOpenRequests } from "./fileOpenRequests";

let waiting: string[] = [];
const take = vi.fn(async () => waiting.shift() ?? null);

beforeEach(() => {
  waiting = [];
  take.mockClear();
  (window as unknown as { api: unknown }).api = { fileOpen: { take, pending: async () => waiting.length > 0 } };
});
afterEach(cleanup);

const settle = () => act(async () => {});

describe("useFileOpenRequests", () => {
  it("leaves a request in main until the surface is ready, then takes it", async () => {
    waiting = ["/home/u/Trip/project.wcpr"];
    const handle = vi.fn();
    const { rerender } = renderHook(({ ready }) => useFileOpenRequests(handle, ready), { initialProps: { ready: false } });
    await settle();
    expect(take).not.toHaveBeenCalled();
    rerender({ ready: true });
    await settle();
    expect(handle.mock.calls).toEqual([["/home/u/Trip/project.wcpr"]]);
  });

  it("takes again on each request main announces", async () => {
    const handle = vi.fn();
    renderHook(() => useFileOpenRequests(handle, true));
    await settle();
    expect(handle).not.toHaveBeenCalled();
    waiting = ["/home/u/Trip/project.wcpr"];
    await act(async () => events.ping!());
    expect(handle.mock.calls).toEqual([["/home/u/Trip/project.wcpr"]]);
  });

  it("handles a request it took even when the surface unmounts meanwhile", async () => {
    waiting = ["/home/u/Trip/Example.wcpk"];
    let release: () => void = () => {};
    take.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(waiting.shift() ?? null) }));
    const handle = vi.fn();
    const { unmount } = renderHook(() => useFileOpenRequests(handle, true));
    unmount();
    await act(async () => release());
    expect(handle.mock.calls, "a taken request was dropped").toEqual([["/home/u/Trip/Example.wcpk"]]);
  });
});
