// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import "../i18n";
import { MEDIA_JOB_EVENTS, type MediaJobEvent } from "../ipc";
import { StatusBar } from "./StatusBar";
import type { Change } from "../../shared/review";

const handlers = vi.hoisted(() => new Map<string, (event: { payload: MediaJobEvent }) => void>());
vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (name, handler) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));
// No backend under jsdom: IPC answers nothing (the review fetch keeps its last
// view; a command's log row goes nowhere).
vi.mock("@/bridge/ipc", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { cleanup(); handlers.clear(); });

it("cached completions do not hide another media item's running generation", async () => {
  const { container } = render(<StatusBar />);
  await act(async () => {});
  const emit = (name: string, payload: MediaJobEvent) => act(() => handlers.get(name)!({ payload }));
  const active = { media_id: "generating-audio", kind: "waveform" };
  emit(MEDIA_JOB_EVENTS.started, active);
  emit(MEDIA_JOB_EVENTS.complete, { media_id: "cached-audio", kind: "conform" });
  expect(container.querySelector(".derivatives-pill")?.textContent).toContain("1");
  emit(MEDIA_JOB_EVENTS.complete, active);
  expect(container.querySelector(".derivatives-pill")).toBeNull();
});

it("duplicate starts and terminal events cannot leave a phantom derivative", async () => {
  const { container } = render(<StatusBar />);
  await act(async () => {});
  const payload = { media_id: "source", kind: "thumbnails" };
  act(() => {
    handlers.get(MEDIA_JOB_EVENTS.started)!({ payload });
    handlers.get(MEDIA_JOB_EVENTS.started)!({ payload });
    handlers.get(MEDIA_JOB_EVENTS.error)!({ payload });
  });
  expect(container.querySelector(".derivatives-pill")).toBeNull();
});

it("shows the unreviewed change count while there is one; a click opens the agent panel's Changes tab", async () => {
  const { useReview, resetReviewForTests } = await import("../agent/reviewStore");
  const { useAgentActivity } = await import("../agent/activityStore");
  const { registerCommandProvider } = await import("../commands/registry");
  resetReviewForTests();
  const open = vi.fn();
  const unregister = registerCommandProvider(() => [{ id: "openAgentPanel", run: open } as never]);
  useAgentActivity.setState({ tab: "activity" });
  const { container } = render(<StatusBar />);
  await act(async () => {});
  expect(container.querySelector('[data-testid="status-bar-review"]')).toBeNull();
  const change = (id: `Layer:${string}`): Change => ({ id, class: "added", details: [], composition_id: "r", ranges: [] });
  act(() => { useReview.getState().apply({ version: { session: 1, revision: 1, baseline_revision: 1 }, content_revision: 1, has_baseline: true, unreviewed: [change("Layer:a"), change("Layer:b")], user: [], user_count: 0, decorations: [] }); });
  const badge = container.querySelector<HTMLElement>('[data-testid="status-bar-review"]')!;
  expect(badge.textContent).toBe("2 to review");
  act(() => badge.click());
  expect(useAgentActivity.getState().tab).toBe("changes");
  expect(open).toHaveBeenCalledTimes(1);
  act(() => { useReview.getState().apply({ version: { session: 1, revision: 1, baseline_revision: 2 }, content_revision: 1, has_baseline: true, unreviewed: [], user: [], user_count: 0, decorations: [] }); });
  expect(container.querySelector('[data-testid="status-bar-review"]')).toBeNull();
  unregister();
  resetReviewForTests();
});
