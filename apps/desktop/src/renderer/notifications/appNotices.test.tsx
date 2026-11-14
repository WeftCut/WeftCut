// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  noticeSettingsPage,
  resetAppNoticesForTests,
  useAppNoticeEvents,
  useAppNotices,
  useAppNoticeStanding,
} from "./appNotices";

afterEach(() => {
  cleanup();
  resetAppNoticesForTests();
  delete (window as unknown as { api?: unknown }).api;
});

type Listener = (payload: unknown) => void;

/// Stub `window.api` with the two halves the mirror uses, and hand back a way
/// to fire the event — main pushes a fresh list whenever a notice is recovered.
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

/// The root that keeps the mirror, reading it as the bell does.
function Probe() {
  useAppNoticeEvents();
  const notices = useAppNotices();
  return <span data-testid="count">{notices.length}</span>;
}

/// A reader elsewhere in the tree: the keyring notice's settings home.
function KeyringHome() {
  return <span>{useAppNoticeStanding("keyring_unavailable") ? "standing" : "clear"}</span>;
}

describe("app notices", () => {
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

  it("is one set for every reader, so a settings home follows the same list as the bell", async () => {
    const api = stubApi(vi.fn().mockResolvedValue([{ level: "warn", code: "keyring_unavailable" }]));
    render(<><Probe /><KeyringHome /></>);
    expect(await screen.findByText("standing")).toBeTruthy();
    act(() => api.emit("app:notices", []));
    expect(await screen.findByText("clear")).toBeTruthy();
  });

  it("gives every notice a settings page to live on", () => {
    expect(noticeSettingsPage("native_decode_unavailable")).toBe("general");
    expect(noticeSettingsPage("keyring_unavailable")).toBe("speech");
    expect(noticeSettingsPage("agent_skill_unavailable")).toBe("agent");
    expect(noticeSettingsPage("agent_skill_stale")).toBe("agent");
  });

  it("unsubscribes on unmount, so a later push cannot reach a dead root", async () => {
    const api = stubApi(vi.fn().mockResolvedValue([]));
    const { unmount } = render(<Probe />);
    await screen.findByText("0");
    unmount();
    expect(api.off).toHaveBeenCalledTimes(1);
  });
});
