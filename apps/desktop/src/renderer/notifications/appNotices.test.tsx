// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useAppNotices } from "./useAppNotices";

afterEach(() => {
  cleanup();
  delete (window as unknown as { api?: unknown }).api;
});

type Listener = (payload: unknown) => void;

/// Stub `window.api` with the two halves the hook uses, and hand back a way to
/// fire the event — main pushes a fresh list whenever a notice is recovered.
function stubApi(notices: () => Promise<unknown>) {
  const listeners = new Map<string, Listener>();
  const off = vi.fn();
  (window as unknown as { api: unknown }).api = {
    app: { notices },
    on: (event: string, cb: Listener) => {
      listeners.set(event, cb);
      return off;
    },
  };
  return { emit: (event: string, payload: unknown) => listeners.get(event)?.(payload), off };
}

function Probe() {
  const notices = useAppNotices();
  return <span data-testid="count">{notices.length}</span>;
}

describe("useAppNotices", () => {
  it("pulls startup notices after mount", async () => {
    stubApi(vi.fn().mockResolvedValue([{ level: "warn", code: "keyring_unavailable" }]));
    render(<Probe />);
    expect(await screen.findByText("1")).toBeTruthy();
  });

  it("keeps the editor clear when the pull fails", async () => {
    stubApi(vi.fn().mockRejectedValue(new Error("offline")));
    render(<Probe />);
    expect(await screen.findByText("0")).toBeTruthy();
  });

  it("takes a pushed list, so a recovered state stops being reported", async () => {
    const api = stubApi(
      vi.fn().mockResolvedValue([{ level: "error", code: "agent_skill_unavailable" }]),
    );
    render(<Probe />);
    expect(await screen.findByText("1")).toBeTruthy();
    act(() => api.emit("app:notices", []));
    expect(await screen.findByText("0")).toBeTruthy();
  });

  it("unsubscribes on unmount, so a later push cannot set state on a dead probe", async () => {
    const api = stubApi(vi.fn().mockResolvedValue([]));
    const { unmount } = render(<Probe />);
    await screen.findByText("0");
    unmount();
    expect(api.off).toHaveBeenCalledTimes(1);
  });
});
