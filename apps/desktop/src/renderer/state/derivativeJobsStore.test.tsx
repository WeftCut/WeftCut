// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MEDIA_JOB_EVENTS, type MediaJobEvent } from "../ipc";
import {
  derivativeJobEnded,
  derivativeJobStarted,
  resetDerivativeJobsForTests,
  useDerivativeJobEvents,
  useDerivativeJobsStore,
} from "./derivativeJobsStore";

const handlers = vi.hoisted(() => new Map<string, (event: { payload: MediaJobEvent }) => void>());
vi.mock("@/bridge/events", () => ({
  listen: vi.fn(async (name, handler) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));
afterEach(() => { cleanup(); handlers.clear(); resetDerivativeJobsForTests(); });

const running = () => Object.keys(useDerivativeJobsStore.getState().jobs).sort();

describe("derivative jobs", () => {
  it("ends only the job it names: a cached completion for another item leaves a running job alone", () => {
    derivativeJobStarted({ media_id: "generating-audio", kind: "waveform" });
    derivativeJobEnded({ media_id: "cached-audio", kind: "conform" });
    expect(running()).toEqual(["generating-audio:waveform"]);
    derivativeJobEnded({ media_id: "generating-audio", kind: "waveform" });
    expect(running()).toEqual([]);
  });

  it("cannot be left with a phantom by duplicate starts and one end", () => {
    const job = { media_id: "source", kind: "thumbnails" };
    derivativeJobStarted(job, 1);
    derivativeJobStarted(job, 2);
    expect(useDerivativeJobsStore.getState().jobs["source:thumbnails"]?.since).toBe(1);
    derivativeJobEnded(job);
    expect(running()).toEqual([]);
  });

  it("follows main's job events while subscribed, and stops when unmounted", async () => {
    function Host() {
      useDerivativeJobEvents();
      return null;
    }
    const { unmount } = render(<Host />);
    await act(async () => {});
    const emit = (name: string, payload: MediaJobEvent) => act(() => handlers.get(name)!({ payload }));
    emit(MEDIA_JOB_EVENTS.started, { media_id: "a", kind: "proxy" });
    emit(MEDIA_JOB_EVENTS.started, { media_id: "b", kind: "waveform" });
    emit(MEDIA_JOB_EVENTS.error, { media_id: "b", kind: "waveform" });
    emit(MEDIA_JOB_EVENTS.complete, { media_id: "a", kind: "proxy" });
    emit(MEDIA_JOB_EVENTS.started, { media_id: "c", kind: "thumbnails" });
    expect(running()).toEqual(["c:thumbnails"]);
    unmount();
    expect(handlers.size).toBe(0);
  });
});
