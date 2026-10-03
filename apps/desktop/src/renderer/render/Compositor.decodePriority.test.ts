import { Container, Texture, type Application } from "pixi.js";
import { describe, expect, it, vi } from "vitest";

import type { LayerSummary, ProjectSummary, TrackSummary } from "../ipc";
import { Compositor } from "./Compositor";
import type {
  DecodeSession,
  DecoderPool,
  FrameSelection,
  FrameStore,
  SourceHandleInit,
} from "./decoder/session";
import { summaryFixture } from "../testing/summaryFixture";
import { FrameRing } from "./decoder/FrameRing";
import { VideoClipSprite } from "./sprite/VideoClipSprite";

function video(id: string, startUs: number, endUs: number): LayerSummary {
  return {
    id,
    label: id,
    t_start_us: startUs,
    t_end_us: endUs,
    kind: "VideoClip",
    color_hint: "#000000",
    enabled: true,
    locked: false,
    params: {
      kind: "VideoClip",
      media_id: `media-${id}`,
      media_label: id,
      src_in_us: 0,
      src_out_us: endUs - startUs,
      speed: 1,
      opacity: { mode: "Static", value: 1 },
      x: { mode: "Static", value: 0 },
      y: { mode: "Static", value: 0 },
      scale_x: { mode: "Static", value: 1 },
      scale_y: { mode: "Static", value: 1 },
      scale_linked: true,
      rotation_deg: { mode: "Static", value: 0 },
      anchor_x: { mode: "Static", value: 0.5 }, anchor_y: { mode: "Static", value: 0.5 },
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
    effects: [],
  };
}

function summary(layers: LayerSummary[]): ProjectSummary {
  const track: TrackSummary = {
    id: "track",
    kind: "Video",
    label: "V1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: "a-roll",
    transient: false,
    layers,
  };
  return summaryFixture({
    project_id: "project",
    name: "Priority wiring",
    media: [],
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    audio_roles: [],
    root: {
      width: 1920,
      height: 1080,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
      duration_us: 10_000_000,
      tracks: [track],
      markers: [],
      links: [],
    },
  });
}

function emptyRing(): FrameStore {
  return {
    selectFrame: (): FrameSelection | null => null,
    frameAt: () => null,
    containsPts: () => false,
    firstPtsUs: () => null,
    lastPtsUs: () => null,
    size: () => 0,
  };
}

describe("Compositor preview decode priority wiring", () => {
  it("reports unsupported on-screen clips even when anchor prewarm discovers them first", () => {
    const onUnsupported = vi.fn();
    const compositor = new Compositor({
      app: { stage: new Container() } as unknown as Application,
      width: 1920,
      height: 1080,
      mode: "preview",
      resolveSource: () => ({ engine: "webcodecs", source: "original", status: "unsupported", target: null, key: null }),
      originalAssetUrl: () => null,
      sourceColor: () => undefined,
      mediaById: () => undefined,
      pool: { dispose: vi.fn(), release: vi.fn() } as unknown as DecoderPool,
      onUnsupported,
    });
    try {
      compositor.setProject(summary([video("unsupported", 0, 2_000_000)]));
      compositor.setAnchorTime(1_000_000);
      expect(onUnsupported).not.toHaveBeenCalled();
      compositor.compositeFrame(1_000_000);
      expect(onUnsupported).toHaveBeenCalledExactlyOnceWith(new Set(["media-unsupported"]));
      compositor.compositeFrame(1_100_000);
      expect(onUnsupported).toHaveBeenCalledTimes(1);
      compositor.compositeFrame(3_000_000);
      expect(onUnsupported).toHaveBeenLastCalledWith(new Set());
      expect(onUnsupported).toHaveBeenCalledTimes(2);
    } finally {
      compositor.dispose();
    }
  });

  it.each(["cold", "cold-group", "empty", "future", "revived"])("keeps the presented scene while an incoming cut refills (%s ring)", (state) => {
    // Keep real rings, clip lifecycle and Pixi scene graph. Only pixel upload
    // needs a GPU, so stand it in with a real non-empty texture.
    const upload = vi.spyOn(VideoClipSprite.prototype, "updateFrame").mockImplementation(function (this: VideoClipSprite) {
      this.bindExternalTexture(Texture.WHITE);
    });
    const sessions = new Map<string, DecodeSession & { ring: FrameRing; disposed: boolean }>();
    const pool: DecoderPool = {
      acquire(init) {
        const s = {
          mediaId: init.mediaId, ring: new FrameRing(), disposed: false,
          ensureReady: async () => {}, requestFrameAt: async () => {}, onFirstFrame: vi.fn(),
          dispose() { this.disposed = true; this.ring.dispose(); },
        };
        sessions.set(init.layerId, s);
        return s;
      },
      release: vi.fn(),
      dispose() { for (const s of sessions.values()) s.dispose(); },
    };
    const compositor = new Compositor({
      app: { stage: new Container() } as unknown as Application,
      width: 1920, height: 1080, mode: "preview", pool,
      resolveSource: (id) => ({ engine: "ffmpeg", source: "original", status: "ok", target: id, key: id }),
      originalAssetUrl: () => null, sourceColor: () => undefined, mediaById: () => undefined,
    });
    const push = (id: string, pts: number) => sessions.get(id)!.ring.push(
      { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap, pts, 33_333,
    );
    try {
      const project = summary([video("outgoing", 0, 1_000_000), video("incoming", 1_000_000, 2_000_000)]);
      if (state === "cold-group") {
        const root = project.compositions[project.root_id]!;
        const incoming = root.tracks[0]!.layers[1]!;
        if (incoming.params.kind !== "VideoClip") throw new Error("fixture");
        incoming.kind = "CompositionRef";
        incoming.params = {...incoming.params, kind: "CompositionRef", composition_id: "child", composition_label: "Child"};
        const childProject = summary([video("leaf", 0, 1_000_000)]);
        project.compositions.child = {...childProject.compositions[childProject.root_id]!, id: "child"};
      }
      compositor.setProject(project);
      const scene = compositor.rootNode().container;
      if (!state.startsWith("cold")) {
        compositor.compositeFrame(1_800_000);
        push("incoming", 800_000);
        compositor.compositeFrame(1_800_000);
      }
      const cachedIncoming = scene.children[0];
      compositor.compositeFrame(800_000);
      push("outgoing", 800_000);
      compositor.compositeFrame(800_000);
      const outgoing = scene.children[0];
      if (state === "revived") sessions.get("incoming")!.dispose();
      else if (state === "empty") sessions.get("incoming")!.ring.flush();
      compositor.setAnchorTime(800_000); // real boundary prewarm / revival
      if (state === "cold-group") expect(sessions.has("incoming/leaf")).toBe(true);
      compositor.compositeFrame(1_000_000); // target has no frame yet
      expect(scene.children).toHaveLength(1);
      expect(scene.children[0]).toBe(outgoing);
      expect(scene.children).not.toContain(cachedIncoming);
      const incomingId = state === "cold-group" ? "leaf" : "incoming";
      expect(compositor.activeClipProbe(incomingId)?.spriteStaged).toBe(false);
      push(state === "cold-group" ? "incoming/leaf" : "incoming", 0);
      compositor.compositeFrame(1_000_000);
      expect(scene.children).toHaveLength(1);
      if (!state.startsWith("cold")) expect(scene.children).toEqual([cachedIncoming]);
      const incoming = scene.children[0];
      expect(compositor.activeClipProbe(incomingId)?.boundFramePtsUs).toBe(0);
      expect(compositor.activeClipProbe(incomingId)?.spriteStaged).toBe(true);
      // Ordinary forward underrun still holds the current clip's valid frame.
      sessions.get(state === "cold-group" ? "incoming/leaf" : "incoming")!.ring.flush();
      compositor.compositeFrame(1_033_333);
      expect(scene.children).toEqual([incoming]);
    } finally {
      compositor.dispose();
      upload.mockRestore();
    }
  });

  it("publishes active/upcoming keys before active acquire and boundary prewarm acquire", () => {
    const events: Array<{ kind: "priority" | "acquire"; value: string[] | string }> = [];
    const sessions = new Map<string, DecodeSession>();
    const pool: DecoderPool = {
      setPriorityKeys(keys) {
        events.push({ kind: "priority", value: [...keys] });
        return false;
      },
      acquire(init: SourceHandleInit) {
        events.push({ kind: "acquire", value: init.layerId });
        const session: DecodeSession = {
          mediaId: init.mediaId,
          ring: emptyRing(),
          disposed: false,
          ensureReady: async () => {},
          dispose: vi.fn(),
          requestFrameAt: vi.fn(async () => {}),
          onFirstFrame: vi.fn(),
        };
        sessions.set(init.layerId, session);
        return session;
      },
      release: vi.fn(),
      dispose: vi.fn(),
    };
    const compositor = new Compositor({
      app: { stage: new Container() } as unknown as Application,
      width: 1920,
      height: 1080,
      mode: "preview",
      resolveSource: (mediaId) => ({
        engine: "ffmpeg",
        source: "original",
        status: "ok",
        target: `C:/${mediaId}.mp4`,
        key: `ffmpeg:original:${mediaId}`,
      }),
      originalAssetUrl: () => null,
      sourceColor: () => undefined,
      mediaById: () => undefined,
      pool,
    });
    compositor.setProject(summary([
      video("active", 4_000_000, 5_500_000),
      video("upcoming", 5_500_000, 5_700_000),
      video("after-short", 5_700_000, 9_000_000),
    ]));

    compositor.setAnchorTime(5_000_000);
    expect(events[0]).toEqual({
      kind: "priority",
      value: ["active", "active#swap", "upcoming", "upcoming#swap", "after-short", "after-short#swap"],
    });
    expect(events[1]).toEqual({ kind: "acquire", value: "active" });

    compositor.setAnchorTime(5_000_000);
    const upcomingAcquire = events.findIndex(
      (event) => event.kind === "acquire" && event.value === "upcoming",
    );
    const priorityEvents = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.kind === "priority");
    expect(priorityEvents).toHaveLength(1);
    expect(upcomingAcquire).toBeGreaterThan(priorityEvents[0]!.index);
    expect(sessions.get("after-short")?.requestFrameAt).toHaveBeenCalledWith(0);
    compositor.dispose();
  });
});
