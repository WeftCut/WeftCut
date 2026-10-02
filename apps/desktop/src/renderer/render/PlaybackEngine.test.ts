import { afterEach, expect, it, vi } from "vitest";
import type { Ticker } from "pixi.js";
import { PlaybackEngine } from "./PlaybackEngine";
import { PreviewAudioEngine } from "./audio/PreviewAudioEngine";
import type { AudioGraph } from "./audio/AudioGraph";
import type { Compositor } from "./Compositor";
import { summaryFixture, ROOT_ID } from "../testing/summaryFixture";

afterEach(() => vi.useRealTimers());
it("detaching/replacing presentation leaves the session playing and unsubscribes the old view", async () => {
  vi.useFakeTimers();
  const graph = { ctx: { state: "running", currentTime: 10 },
    resume: async () => {}, dispose: vi.fn() } as unknown as AudioGraph;
  const audio = new PreviewAudioEngine(graph, () => null);
  audio.setProject(summaryFixture(), ROOT_ID);
  const compositor = { setMasterPlayState: vi.fn(), setScrubbing: vi.fn() } as unknown as Compositor;
  const ticker = { add: vi.fn(), remove: vi.fn() } as unknown as Ticker;
  const first = new PlaybackEngine({ compositor, ticker, audio });
  audio.play();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(audio.isPlaying()).toBe(true);
  first.dispose();
  vi.mocked(compositor.setMasterPlayState).mockClear();
  expect(audio.isPlaying()).toBe(true);
  expect(graph.dispose).not.toHaveBeenCalled();
  const secondCompositor = { setMasterPlayState: vi.fn(), setScrubbing: vi.fn() } as unknown as Compositor;
  const second = new PlaybackEngine({ compositor: secondCompositor, ticker, audio });
  expect(secondCompositor.setMasterPlayState).toHaveBeenCalledWith(true);
  audio.pause();
  expect(secondCompositor.setMasterPlayState).toHaveBeenLastCalledWith(false);
  expect(compositor.setMasterPlayState).not.toHaveBeenCalled();
  second.dispose(); audio.dispose();
  expect(graph.dispose).toHaveBeenCalledOnce();
});
