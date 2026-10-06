// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import "../i18n";
import { MEDIA_JOB_EVENTS, type MediaJobEvent } from "../ipc";
import { StatusBar } from "./StatusBar";

const handlers = vi.hoisted(() => new Map<string, (event: { payload: MediaJobEvent }) => void>());
vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (name, handler) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));
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
