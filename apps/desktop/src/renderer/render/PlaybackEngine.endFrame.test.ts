import { Container, Sprite, type Application, type Ticker } from "pixi.js";
import { afterEach, expect, it, vi } from "vitest";
import { summaryFixture, ROOT_ID } from "../testing/summaryFixture";
import type { LayerSummary } from "../ipc";
import { Compositor } from "./Compositor";
import { PlaybackEngine } from "./PlaybackEngine";
import { PreviewAudioEngine } from "./audio/PreviewAudioEngine";
import type { AudioGraph } from "./audio/AudioGraph";
import type { DecoderPool } from "./decoder/session";
import { getMotif } from "./motifs/catalog";
import { motifFrameDescriptor } from "./motifs/motifFrameDescriptor";
import { sharedMotifFrameCache } from "./motifs/motifRasterCache";

afterEach(() => {
  sharedMotifFrameCache.clearAll();
  vi.useRealTimers();
});

it("keeps the final Motif on stage across ticks before and after the end timer", async () => {
  vi.useFakeTimers();
  const summary = summaryFixture({ root: {
    duration_us: 2_000_000,
    tracks: [{ id: "track", kind: "Video", label: "V1", enabled: true,
      locked: false, muted: false, solo: false, role: "a-roll", transient: false,
      layers: [{ id: "motif", label: null, kind: "Motif", enabled: true,
        locked: false, color_hint: "#fff", effects: [], t_start_us: 0, t_end_us: 2_000_000,
        params: { kind: "Motif", motif_id: "countdown", src_in_us: 0, props: { seconds: 2 } },
      } as unknown as LayerSummary] }],
  } });
  const desc = motifFrameDescriptor({ src_in_us: 0, props: { seconds: 2 } },
    0, 2_000_000, 30, 1, getMotif("countdown")!)!;
  for (let frame = 0; frame < desc.contentDurationFrames; frame++) {
    sharedMotifFrameCache.setFrame(desc.cacheKey, frame,
      { width: 320, height: 320, close: vi.fn() } as unknown as ImageBitmap);
  }
  const ctx = { state: "running", currentTime: 10 };
  const audio = new PreviewAudioEngine({ ctx, resume: async () => {}, dispose: vi.fn() } as unknown as AudioGraph, () => null);
  audio.setProject(summary, ROOT_ID);
  const compositor = new Compositor({ app: { stage: new Container() } as unknown as Application,
    width: 1920, height: 1080, mode: "preview", originalAssetUrl: () => null,
    sourceColor: () => undefined, mediaById: () => undefined,
    pool: { dispose: vi.fn() } as unknown as DecoderPool });
  compositor.setProject(summary);
  let tick!: () => void;
  const ticker = { add: (cb: () => void) => { tick = cb; }, remove: vi.fn(),
    lastTime: 0, elapsedMS: 16 } as unknown as Ticker;
  const playback = new PlaybackEngine({ compositor, ticker, audio });
  const visibleSprites = (container: Container): Sprite[] => container.children.flatMap(
    child => child instanceof Sprite ? [child] : visibleSprites(child));
  try {
    audio.play();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    // Render the last valid frame, then advance the device clock without
    // firing the independently scheduled transport timer.
    ctx.currentTime = 11.975;
    tick();
    const lastSprite = visibleSprites(compositor.stage)[0];
    expect(lastSprite).toBeDefined();
    const samples: number[] = [];
    const texture = lastSprite!.texture;
    for (const time of [11.995, 12.015]) {
      ctx.currentTime = time;
      tick();
      samples.push(visibleSprites(compositor.stage).length);
      expect(audio.isPlaying()).toBe(true);
      expect(lastSprite!.destroyed).toBe(false);
      expect(texture.source.destroyed).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(16);
    tick();
    samples.push(visibleSprites(compositor.stage).length);
    expect(audio.isPlaying()).toBe(false);
    expect(visibleSprites(compositor.stage)[0]).toBe(lastSprite);
    expect(lastSprite!.texture).toBe(texture);
    expect(samples).toEqual([1, 1, 1]);
  } finally {
    playback.dispose();
    audio.dispose();
    compositor.dispose();
  }
});
