// One composition INSTANCE's sprites, mixers and Pixi `Container`, and the
// two sweeps that drive them — the audio pass and the visual pass — at a time
// on that composition's own clock. The Compositor holds one node for the open
// composition and stages its container; a `CompositionRefSprite` holds one for
// the Group layer it draws and renders its container into a texture. Same
// class, same `ensureX / updateX` machinery, entered at a different node.
//
// One node per Group LAYER, not per composition: two placements of the same
// composition sit at different offsets, so at one playhead they show two
// different frames of the same clip — two decode positions, two rings, two
// sets of sprites. Anything the node hands to a shared service is keyed by
// `instanceKey(path, layerId)` for the same reason.
//
// What the node does NOT own: the decoder pool, the ingest shaders, the audio
// bus, the motif prewarm/bake planners, underrun accounting, presentation.
// Those are the Compositor's, reached through `CompositionNodeHost`.
//
// Plan: docs/render.md

import { Container, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";

import { snapFrameFloor } from "../frames";
import type {
  CompositionSummary,
  LayerSummary,
  MediaSummary,
  ProjectSummary,
  RoleMixView,
} from "../ipc";
import { anchorPivot } from "./anchorPivot";
import { withTextBoxOverride, withTransformOverride } from "./transformOverrides";
import type { AudioGraph } from "./audio/AudioGraph";
import { AudioMixer } from "./audio/AudioMixer";
import { anyRoleSolo, auditionedRoleGainLinear, roleAudible } from "./audio/roleGate";
import type { ClockAnchor } from "./audio/chunkSchedule";
import {
  resolveColorView,
  resolveCompositionRefView,
  resolveImageOverlayView,
  resolveMotifView,
  resolveTextView,
  resolveVideoClipView,
} from "./resolveView";
import { SourceHandle } from "./decoder/SourceDecoderPool";
import type { DecodeSession, DecoderPool } from "./decoder/session";
import type { HandoffTimingSummary } from "./decoder/transports/handoffTimings";
import { FfmpegSource } from "./decoder/FfmpegSource";
import { markFfmpegUnusable } from "./decoder/ffmpegCapability";
import { exportHandleKey } from "./decoder/ExportDecoderPool";
import { ColorSprite } from "./sprite/ColorSprite";
import { CompositionRefSprite } from "./sprite/CompositionRefSprite";
import { ImageOverlaySprite } from "./sprite/ImageOverlaySprite";
import { MotifSprite } from "./sprite/MotifSprite";
import { TextSprite } from "./sprite/TextSprite";
import { VideoClipSprite } from "./sprite/VideoClipSprite";
import { swapKeys } from "./swapKeys";
import { isNativeNv12Frame, isTenBitFrame } from "./decoder/decodedFrame";
import type { Nv12Ingest } from "./nv12/Nv12Ingest";
import type { TenBitIngest } from "./tenbit/TenBitIngest";
import type { TextFit } from "./textBox";
import { EffectChain } from "./effects/EffectChain";
import type { StageableSprite } from "./sprite/StageableSprite";
import { effectsFor } from "./effects/effectsFor";
import { selectActiveTransitions } from "./transitions/activeTransitions";
import { TransitionNodeManager } from "./transitions/TransitionNodes";
import { STAGE, stageAdd, stageNow } from "./perf/stageTimers";
import { judgeFrameSelection } from "./underrunTracker";
import {
  childFrame,
  compositionLocalUs,
  instanceKey,
  MAX_COMPOSITION_DEPTH,
  placeLayer,
  refPath,
} from "./compositionWalk";

/// Preview mode's resolved decode source for one media, produced by the injected
/// `resolveSource` (PixiPreview gathers the store inputs and runs the pure
/// `resolveDecodeEngine`). `target` is the decode target: for `engine: "ffmpeg"`
/// it's the original file PATH (the pool decodes it directly, ignoring
/// `proxyAssetUrl`); for `engine: "webcodecs"` it's ALREADY `convertFileSrc`'d.
/// `status: "unsupported"` means no decodable target exists for this media at
/// all (surfaced via `CompositorInit.onUnsupported`); `"pending"` means the
/// resolver expects one soon (proxy building, decodability untested) and
/// `target` is null. `key` = `${engine}:${source}:${target}` is the swap
/// IDENTITY: it changes only when the resolved engine, source, or decode
/// target changes, so a landed proxy can never displace an already-decoding
/// original (feedback_native_nle_conventions).
export interface ResolvedRendererSource {
  engine: import("./decoder/decodeEngine").DecodeEngine;
  source: import("./decoder/decodeEngine").DecodeSource;
  status: "ok" | "pending" | "unsupported";
  target: string | null;
  key: string | null;
}

/// Export mode has exactly one source (the proxy/master, decoded via
/// WebCodecs). Wrap its asset URL in the `ResolvedRendererSource` shape so
/// `ensureClip` runs ONE acquire path across preview + export; preview injects
/// the real engine resolver instead.
function rsFromExportProxy(url: string | null): ResolvedRendererSource | null {
  return url
    ? { engine: "webcodecs", source: "proxy", status: "ok", target: url, key: `webcodecs:proxy:${url}` }
    : null;
}

/// THE one place decode-path identity is derived, shared by `activeClipProbe`
/// (E2E) and `getPerfSnapshot` (PerfHUD) so the two can never disagree about
/// which lane a clip is on. Discriminated by `instanceof` + `currentLane()`,
/// NOT `constructor.name` — the minified E2E renderer build mangles it.
export function sourceKindOf(source: DecodeSession): ActiveClipProbe["sourceKind"] {
  if (source instanceof FfmpegSource) {
    return source.currentLane() === "software" ? "sw" : "native-gpu";
  }
  return source instanceof SourceHandle ? "webcodecs" : "unknown";
}

/// A bound texture's natural extent, or null while the sprite still holds the
/// EMPTY placeholder (nothing decoded yet — the gizmo shows no box rather than
/// a 1×1 one).
function textureSize(texture: Texture): { w: number; h: number } | null {
  if (texture === Texture.EMPTY) return null;
  const { width: w, height: h } = texture.orig;
  return w > 0 && h > 0 ? { w, h } : null;
}

/// E2E-only diagnostic snapshot of ONE active VideoClip's decode source plus
/// its bound sprite. The preview-sw conformance spec reads this to prove the
/// runtime path (import → native-sw route → `resolveSource` resolves the
/// ffmpeg engine → acquire) ends in a real `FfmpegSource` on its software lane
/// AND that a decoded frame reached the sprite — the single runtime fact no
/// other surface exposes. All fields are plain numbers/strings/booleans so
/// the whole thing survives the `page.evaluate` boundary.
export interface ActiveClipProbe {
  layerId: string;
  mediaId: string;
  /// Which concrete decode handle/lane backs `ActiveClip.source`, derived by
  /// `sourceKindOf`. `"sw"` is the ffmpeg software-decode lane, `"native-gpu"`
  /// its hardware lane.
  sourceKind: "webcodecs" | "native-gpu" | "sw" | "unknown";
  /// Derived from `sourceKind === "sw"`: whether the active handle is the native
  /// software-decode path. Kept as a distinct field so the spec can assert the
  /// software tier explicitly.
  isSoftware: boolean;
  /// True once the pool's idle sweeper has reclaimed this handle.
  sourceDisposed: boolean;
  /// Decoded frames currently buffered in the handle's ring. For the SW lane a
  /// non-zero value means `FfmpegSource`'s `SwTransport` converted NV12 →
  /// VideoFrame → ImageBitmap and pushed it — i.e. the native decoder produced
  /// real output.
  ringSize: number;
  /// PTS (µs) of the earliest / latest frame buffered in the ring, or null when
  /// empty. The spec waits for `ringLastPtsUs >= target` so it captures the
  /// seeked frame rather than an earlier one the ring surfaced while catching up.
  ringFirstPtsUs: number | null;
  ringLastPtsUs: number | null;
  /// Where this clip's decoded frames went (see `FrameRingFate`), null on a
  /// store without a retention window. Carried here as well as on
  /// `CompositorPerfSnapshot` because the playback bench reads the two probes at
  /// different points — the perf snapshot brackets the measured window, while
  /// this one is also sampled during the pre-window route verification, where a
  /// clip already churning before the window opens is worth seeing.
  ringFate: import("./decoder/FrameRing").FrameRingFate | null;
  /// True once a real (non-EMPTY) texture is bound to the sprite. A VideoClip
  /// snapshots the ring's ImageBitmap into its own canvas, so "the bitmap
  /// reached the sprite" shows up as a bound, correctly-sized texture rather
  /// than a live ImageBitmap resource.
  spriteBound: boolean;
  spriteWidth: number;
  spriteHeight: number;
  /// Identity of the frame currently held by the sprite. Unlike the ring
  /// bounds, these values change only after `updateClip` successfully binds a
  /// selected frame; on a decode miss they keep describing the held frame.
  boundFramePtsUs: number | null;
  boundFrameDurationUs: number | null;
  boundFrameSourceKey: string | null;
  /// Which ingest path produced the bound pixels — `"p10"` (TenBitIngest),
  /// `"nv12"` (Nv12Ingest), `"browser"` (snapshot of a decoder-produced
  /// frame), or null before the first bind. The 10-bit VideoToolbox
  /// conformance variants assert `"p10"` to prove the frame rode the ten-bit
  /// ingest.
  boundFrameKind: "p10" | "nv12" | "browser" | null;
  /// The resolved HW lane (`nvdec`|`vaapi`|`videotoolbox`|`d3d11va`) when the
  /// active clip's source is a `FfmpegSource` on its hardware lane, else null
  /// (software lane, a WebCodecs source, or no matching clip). The
  /// lane-parameterized preview-hw conformance spec asserts this to prove WHICH
  /// HW lane engaged.
  hwLane: string | null;
  /// The resolver IDENTITY (`${engine}:${source}:${target}`) the active clip's
  /// source was built from — see `ActiveClip.builtFromKey`. Lets the decode-
  /// engine e2e spec assert the resolved ENGINE/SOURCE (the two
  /// leading segments) rather than inferring it from `sourceKind` alone, which
  /// can't distinguish webcodecs-original from webcodecs-proxy — both decode
  /// through the WebCodecs pool and surface as `sourceKind: "webcodecs"`. Null
  /// only when `activeClipProbe` itself returns null (no matching clip).
  builtFromKey: string | null;
}

/// One live VideoClip's per-clip row of the PerfHUD snapshot.
export interface ClipPerfRow {
  layerId: string;
  mediaId: string;
  /// `VideoDecoder.decodeQueueSize` at sample time.
  decodeQueueSize: number;
  /// Number of frames currently cached in the per-clip ring.
  ringSize: number;
  /// PTS of the ring's earliest cached frame; null if the ring is empty.
  ringFirstPtsUs: number | null;
  /// PTS of the ring's latest frame; null if the ring is empty.
  ringLastPtsUs: number | null;
  /// Cumulative frames decoded for this clip; the HUD diffs it into fps.
  decodedFrameCount: number;
  /// Which decode path actually backs this clip right now — the same
  /// discriminator `activeClipProbe` reports. NOT derivable from
  /// `downgraded`: a clip that STARTED on software (10-bit, ProRes, DNx —
  /// anything off the HW allow-list) never downgraded, so reading
  /// `downgraded` as a lane prints "hardware" for the whole software lane.
  sourceKind: ActiveClipProbe["sourceKind"];
  /// True only if this handle STARTED on hardware and fell back at runtime
  /// (device loss, decode error, HW-session budget). Orthogonal to
  /// `sourceKind`: it is the transition, not the current state.
  downgraded: boolean;
  /// Hardware lane only: the preload's per-frame handoff cost, whose
  /// `barrier` component is the synchronous GPU drain each session pays
  /// before its slot recycles. Null on every other path.
  handoff: HandoffTimingSummary | null;
  /// True when the ring's lookahead window is satisfied (decoder not
  /// running behind the playhead).
  lookaheadFull: boolean;
  /// Where this clip's decoded frames went — see `FrameRingFate`. Null on the
  /// export store, which has no retention window to lose one to.
  ///
  /// This is the counter set that separates "never decoded" from "decoded and
  /// thrown away": `decodedFrameCount` is incremented by BOTH engines before
  /// they call `ring.push`, so a frame the ring then rejects as stale is
  /// counted as delivered and never held. Diff two snapshots for rates; read
  /// `serveRepeat` absolutely, since a held frame is a judder event the
  /// dropped-frame counter is blind to.
  ringFate: import("./decoder/FrameRing").FrameRingFate | null;
  /// WebCodecs only: decoder outputs awaiting `createImageBitmap`, each
  /// pinning a hardware decode-pool slot (ADR 0004). Null on every other lane.
  conversionBacklog: { inFlight: number; peak: number } | null;
}

/// The Compositor as a node sees it: the shared services and the per-tick
/// engine state every node reads, none of which a node owns. Method-shaped
/// where the value moves per tick so a node never caches a stale copy.
export interface CompositionNodeHost {
  /// `app.renderer` — for the transition node's RTs and a Group's texture.
  /// Undefined only in renderer-less unit tests, which stage nothing that
  /// needs it.
  readonly renderer: Renderer | undefined;
  readonly pool: DecoderPool;
  /// Preview or export. Gates audio setup, decode-source resolution
  /// (`resolveSource` vs `proxyAssetUrl`), and underrun judging.
  readonly mode: "preview" | "export";
  fpsNum(): number;
  fpsDen(): number;
  playing(): boolean;
  scrubbing(): boolean;
  clockAnchor(): ClockAnchor | null;
  /// Master audio bus (preview only; null in the export Worker).
  audioGraph(): AudioGraph | null;
  audioRoles(): readonly RoleMixView[];
  resolveSource(mediaId: string): ResolvedRendererSource | null;
  proxyAssetUrl(mediaId: string): string | null;
  originalAssetUrl(mediaId: string): string | null;
  sourceColor(mediaId: string): VideoColorSpaceInit | undefined;
  mediaById(mediaId: string): MediaSummary | undefined;
  conformAssetUrl(mediaId: string): string | null;
  /// Export-only pre-baked Motif frames for `instanceKey(path, layerId)`;
  /// undefined in preview and for an unbaked layer.
  motifFrames(key: string): readonly ImageBitmap[] | undefined;
  ensureTenBitIngest(): TenBitIngest;
  ensureNv12Ingest(): Nv12Ingest;
  /// Drop both ingests' per-clip state for a pool key that is going away.
  releaseIngest(key: string): void;
  scheduleRepaint(): void;
  /// A media no engine can decode was met during this composite's sweep.
  noteUnsupported(mediaId: string): void;
  /// A visible VideoClip painted a stale or missing frame this sweep.
  noteLateLayer(): void;
}

export interface CompositionNodeInit {
  host: CompositionNodeHost;
  composition: CompositionSummary;
  /// The whole summary, for resolving Group layers' compositions. Null while
  /// no project is loaded (then `composition` is the empty sentinel).
  summary: ProjectSummary | null;
  /// The size everything composition-sized is built against: the Group's own
  /// `width × height` for a child, the Compositor's for the open composition.
  width: number;
  height: number;
  /// Instance identity — see `compositionWalk.ts` `refPath` / `instanceKey`.
  path: string;
  depth: number;
  /// Root-time frame for the audio pass and the export handle keys.
  offsetUs: number;
  windowStartUs: number;
  windowEndUs: number;
  /// Stage into this container instead of a fresh one. The Compositor lends
  /// its `stage` so the open composition's node can be rebuilt on a scope
  /// switch without the stage's own identity changing.
  container?: Container;
}

interface ActiveClip {
  layerId: string;
  /// The pool key this instance's session lives under (`instanceKey`).
  key: string;
  mediaId: string;
  source: DecodeSession;
  sprite: VideoClipSprite;
  effects: EffectChain;
  /// The resolver IDENTITY (`${engine}:${source}:${target}`) the current
  /// `source` was built from. When the resolver later returns a different key
  /// for this media, `ensureClip` starts a no-flash overlap-swap to the new
  /// source. Key semantics: see `ResolvedRendererSource`.
  builtFromKey: string;
  /// Presentation identity of the pixels currently held by `sprite`. Kept
  /// independently from the ring because a frameAt miss deliberately holds
  /// the previous image, and independently from builtFromKey because a
  /// no-flash source swap keeps the old pixels until the new source binds.
  boundFramePtsUs: number | null;
  boundFrameDurationUs: number | null;
  boundFrameSourceKey: string | null;
  /// Which ingest path produced the pixels currently bound to `sprite` —
  /// `"p10"` (TenBitIngest), `"nv12"` (Nv12Ingest) or `"browser"` (the
  /// snapshot path for decoder-produced frames). E2E-observable via
  /// `activeClipProbe`, so the 10-bit conformance variants can assert the
  /// frame actually rode the ten-bit ingest rather than inferring it.
  boundFrameKind: "p10" | "nv12" | "browser" | null;
  /// Diagnostic edge-trigger: true if the last `updateClip` call
  /// found `ring.selectFrame(srcTUs)` returned null. Used so the
  /// null-selection log fires once per transition rather than
  /// every rAF tick during the null window.
  loggedNull: boolean;
}

/// An in-flight no-flash source-swap (preview only). Holds a SECOND decoder
/// handle on the new URL until its ring has the current visible frame, then
/// atomically repoints `ActiveClip.source` to it and releases the original.
/// Keyed in `CompositionNode.swaps` by the clip's real layerId.
interface SwapState {
  handle: DecodeSession;
  /// Pool key of the synthetic swap handle (`${key}#swap`).
  swapLayerId: string;
  /// The resolver IDENTITY (`${engine}:${source}:${target}`) the swap handle
  /// is decoding toward. Becomes the clip's `builtFromKey` on completion; the
  /// in-flight dedupe compares it against the freshly-resolved key.
  key: string;
  /// Bounded poll driving the swap to completion (cleared on done/abandon).
  timer: ReturnType<typeof setInterval> | null;
  /// Safety deadline: abandon the swap if it never produces the frame.
  deadline: ReturnType<typeof setTimeout> | null;
}

interface ActiveImage {
  layerId: string;
  mediaId: string;
  sprite: ImageOverlaySprite;
  effects: EffectChain;
}

interface ActiveColor {
  layerId: string;
  sprite: ColorSprite;
  effects: EffectChain;
}

interface ActiveText {
  layerId: string;
  sprite: TextSprite;
  effects: EffectChain;
}

interface ActiveMotif {
  layerId: string;
  motifId: string;
  sprite: MotifSprite;
  effects: EffectChain;
}

interface ActiveRef {
  layerId: string;
  compositionId: string;
  sprite: CompositionRefSprite;
  effects: EffectChain;
}

interface ActiveAudio {
  layerId: string;
  mediaId: string;
  mixer: AudioMixer;
  /// Change detection for `updateView`: the params object reference is
  /// stable between `setComposition` calls, so per-tick comparison is one
  /// identity check; on a new summary the JSON guard avoids tearing down
  /// the mixer's schedule when nothing audio-relevant actually changed.
  lastParamsRef: unknown;
  lastParamsJson: string;
  /// Last role-bus linear gain folded into the mixer. A role-gain change
  /// (or role mute/solo flip changing audibility) must re-derive the mixer
  /// even when `layer.params` is reference-stable, so it joins the
  /// change-detection guard. Sentinel `NaN` forces the first `updateView`.
  lastRoleGain: number;
}

export interface EffectOpts {
  previewEffectsEnabled: boolean;
}

export class CompositionNode {
  /// What this node stages into. The Compositor's `stage` for the open
  /// composition; a `CompositionRefSprite`'s render source for a Group.
  readonly container: Container;
  readonly path: string;
  readonly depth: number;
  composition: CompositionSummary;
  private summary: ProjectSummary | null;
  private readonly host: CompositionNodeHost;
  private readonly ownsContainer: boolean;
  private width: number;
  private height: number;
  /// Root-time frame: local `t` ↔ root `t + offsetUs`; the window is the
  /// intersection of every enclosing Group's placement (±∞ at the root).
  private offsetUs: number;
  private windowStartUs: number;
  private windowEndUs: number;
  private clips = new Map<string, ActiveClip>();
  private images = new Map<string, ActiveImage>();
  /// In-flight loadFromAsset promises, keyed by layerId. Used by `preloadImages`
  /// so the export Worker can await all image loads before the frame loop.
  private imageLoadPromises = new Map<string, Promise<void>>();
  private colors = new Map<string, ActiveColor>();
  private texts = new Map<string, ActiveText>();
  private activeMotifs = new Map<string, ActiveMotif>();
  private refs = new Map<string, ActiveRef>();
  private audios = new Map<string, ActiveAudio>();
  /// In-flight no-flash source-swaps, keyed by the clip's real layerId.
  /// Preview-only; empty in export mode (export URLs are fixed per run).
  private swaps = new Map<string, SwapState>();
  /// O(1) layer lookup by id. Rebuilt in `setComposition` whenever the
  /// snapshot changes; read on every tick from `anchor` and `hasLookaheadAt`.
  /// Without this map those would be O(layers) per active clip per tick —
  /// quadratic for long timelines.
  private layerById = new Map<string, LayerSummary>();
  /// layerId → owning track's `enabled`, maintained alongside `layerById`;
  /// feeds the per-frame active-transition selection without re-walking
  /// tracks.
  private trackEnabledByLayer = new Map<string, boolean>();
  /// Two-input transition node (transitions/TransitionNodes.ts) for THIS
  /// composition's transitions, sized to this node. Lazily built on the first
  /// active window so transition-free compositions (and mock-App unit tests)
  /// never touch the renderer for it.
  private transitionNodes: TransitionNodeManager | null = null;
  /// Media ids already warned about a missing conform (once per media,
  /// cleared when the conform shows up).
  private conformWarned = new Set<string>();
  /// Depth-cap refusal logged once per node.
  private warnedDepth = false;
  /// Most recent LOCAL composition time this node composited at; the swap
  /// poll reads it to find the visible frame.
  private lastTUs = 0;
  private disposed = false;

  constructor(init: CompositionNodeInit) {
    this.host = init.host;
    this.composition = init.composition;
    this.summary = init.summary;
    this.width = init.width;
    this.height = init.height;
    this.path = init.path;
    this.depth = init.depth;
    this.offsetUs = init.offsetUs;
    this.windowStartUs = init.windowStartUs;
    this.windowEndUs = init.windowEndUs;
    this.ownsContainer = init.container === undefined;
    this.container = init.container ?? new Container();
    this.setComposition(init.composition, init.summary);
  }

  /// Duration of this node's composition — the playhead's bound when it is
  /// the open one.
  durationUs(): number {
    return this.composition.duration_us;
  }

  /// The pool key for a layer of this instance. The bare layer id at the root
  /// (a flat project's keys are unchanged); path-prefixed inside a Group.
  keyFor(layerId: string): string {
    return instanceKey(this.path, layerId);
  }

  /// Adopt a new snapshot of this composition. Sprites for layers that have
  /// disappeared get evicted; new layers appear on the next sweep if active.
  /// Child nodes follow: a Group layer whose composition still resolves keeps
  /// its node and re-reads it; one whose target changed or vanished is torn
  /// down here and rebuilt lazily by the sweep.
  setComposition(composition: CompositionSummary, summary: ProjectSummary | null): void {
    this.composition = composition;
    this.summary = summary;
    this.layerById.clear();
    this.trackEnabledByLayer.clear();
    const livingLayerIds = new Set<string>();
    for (const t of composition.tracks) {
      for (const l of t.layers) {
        livingLayerIds.add(l.id);
        this.layerById.set(l.id, l);
        this.trackEnabledByLayer.set(l.id, t.enabled);
      }
    }
    for (const [layerId, c] of this.clips) {
      if (!livingLayerIds.has(layerId)) this.evictClip(layerId, c);
    }
    for (const [layerId, i] of this.images) {
      if (!livingLayerIds.has(layerId)) {
        i.sprite.dispose();
        i.effects.dispose();
        this.images.delete(layerId);
        // Delete + undo restores the same layer id; a reservation left behind
        // here is exactly the stale completion ensureImage's identity check
        // defends against — clean it at the source too.
        this.imageLoadPromises.delete(layerId);
      }
    }
    for (const [layerId, c] of this.colors) {
      if (!livingLayerIds.has(layerId)) {
        c.sprite.dispose();
        c.effects.dispose();
        this.colors.delete(layerId);
      }
    }
    for (const [layerId, t] of this.texts) {
      if (!livingLayerIds.has(layerId)) {
        t.sprite.dispose();
        t.effects.dispose();
        this.texts.delete(layerId);
      }
    }
    for (const [layerId, t] of this.activeMotifs) {
      if (!livingLayerIds.has(layerId)) {
        t.sprite.dispose();
        t.effects.dispose();
        this.activeMotifs.delete(layerId);
      }
    }
    for (const [layerId, a] of this.audios) {
      if (!livingLayerIds.has(layerId)) {
        a.mixer.dispose();
        this.audios.delete(layerId);
      }
    }
    for (const [layerId, r] of this.refs) {
      const layer = this.layerById.get(layerId);
      const target =
        layer && layer.params.kind === "CompositionRef"
          ? summary?.compositions[layer.params.composition_id]
          : undefined;
      if (!layer || layer.params.kind !== "CompositionRef" || !target || target.id !== r.compositionId) {
        r.sprite.dispose();
        r.effects.dispose();
        this.refs.delete(layerId);
        continue;
      }
      const frame = childFrame(
        layer,
        layer.params.src_in_us,
        this.offsetUs,
        this.windowStartUs,
        this.windowEndUs,
      );
      r.sprite.node.setPlacement(frame.offsetUs, frame.windowStartUs, frame.windowEndUs);
      r.sprite.setComposition(target, summary);
    }
  }

  /// Re-anchor this instance in root time (its Group layer moved or was
  /// re-trimmed). Children are re-framed by the `setComposition` that follows.
  setPlacement(offsetUs: number, windowStartUs: number, windowEndUs: number): void {
    this.offsetUs = offsetUs;
    this.windowStartUs = windowStartUs;
    this.windowEndUs = windowEndUs;
  }

  /// Adopt a new composition size. Two things are sized against it and
  /// neither self-corrects: the transition RT pool (it re-sizes only when
  /// told) and every already-built `ImageOverlaySprite` (it bakes
  /// `maxWidth`/`maxHeight` into its animated-image cache key at construction,
  /// and the per-frame image sweep only rebuilds a sprite whose LAYER went
  /// away). Both are handled here.
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    // Stale-size RTs are destroyed as they come back (see TransitionRtPool).
    this.transitionNodes?.setSize(width, height);
    // Evict image sprites so the next composite re-creates them at the new
    // cap; same dispose pair the per-frame sweep uses. The load reservation
    // goes with the sprite it belongs to — a survivor here would let a stale
    // completion delete the re-created sprite's entry (see ensureImage).
    for (const [layerId, i] of this.images) {
      i.sprite.dispose();
      i.effects.dispose();
      this.images.delete(layerId);
      this.imageLoadPromises.delete(layerId);
    }
  }

  // ============================================================
  // The two sweeps
  // ============================================================

  /// Audio pass at LOCAL time `tUs` (already on the frame grid). Ensures a
  /// mixer for every audible Audio layer, ticks it against the root clock, and
  /// recurses into Group layers inside their window. Mixers and children the
  /// gates skipped this tick get a pause-shaped tick so their pre-scheduled
  /// chunks stop now, not when the gate flips back.
  ///
  /// VideoClip layers are NOT eligible. Mirrors `audio::mix`'s canonical
  /// export routing: only Audio layers are audible; VideoClips are
  /// video-only. Import's `auto_pair_audio_on_import` (default-on)
  /// places a sibling Audio layer on the same media for the audio
  /// track. Treating the VideoClip as also audio-bearing here would
  /// play the same audio twice — the audible doubling bug.
  compositeAudio(tUs: number): void {
    if (this.disposed) return;
    // Audio gates — mirror audio/mix.rs audible_audio_layers semantics:
    // whole-track disable still gates, but audio mute/solo now lives on
    // ROLES (mute wins over solo; an absent role defaults audible iff no
    // role is soloed). Gated-out layers are skipped here, then swept below
    // with a pause-shaped tick so their pre-scheduled chunks stop
    // immediately. (Preview ignores `locked`, matching the live behavior.)
    const roles = this.host.audioRoles();
    const anySolo = anyRoleSolo(roles);
    const playing = this.host.playing();
    const anchor = this.host.clockAnchor();
    // The mixers schedule against the ROOT clock: a layer inside a Group is
    // placed at its root-time interval, clipped to the Group's window, and
    // reads its source `headUs` in — the Rust mixer's `PlacedAudio` frame.
    const tRootUs = tUs + this.offsetUs;
    const tickedAudio = new Set<string>();
    const tickedRefs = new Set<string>();
    for (const track of this.composition.tracks) {
      if (!track.enabled) continue; // whole-track disable still gates
      for (const layer of track.layers) {
        if (!layer.enabled) continue;
        if (layer.params.kind === "CompositionRef") {
          if (tUs < layer.t_start_us || tUs >= layer.t_end_us) continue;
          const ref = this.ensureCompositionRef(layer);
          if (!ref) continue;
          tickedRefs.add(layer.id);
          // The same mapping the visual pass makes through
          // `CompositionRefSprite.update`, so both sweeps agree on which frame
          // of the Group they are looking at.
          ref.sprite.node.compositeAudio(
            compositionLocalUs(
              layer.params.src_in_us + (tUs - layer.t_start_us),
              this.host.fpsNum(),
              this.host.fpsDen(),
            ),
          );
          continue;
        }
        if (layer.params.kind !== "Audio") continue;
        if (!roleAudible(layer.params.role, roles, anySolo)) continue;
        const audio = this.ensureAudio(layer);
        if (!audio) continue;
        const placed = placeLayer(layer, this.offsetUs, this.windowStartUs, this.windowEndUs);
        if (placed.tStartUs >= placed.tEndUs) continue;
        // Audition override (live fader drag) folds in place of the
        // committed Role gain; equal to `roleGainLinear` when idle.
        const rGain = auditionedRoleGainLinear(layer.params.role, roles);
        // The clipped head/tail become a source trim so the mixer needs no
        // notion of Groups. The unclipped case hands the params object
        // through untouched, keeping the identity fast path.
        const params =
          placed.headUs === 0 && placed.tailUs === 0
            ? layer.params
            : {
                ...layer.params,
                src_in_us: layer.params.src_in_us + placed.headUs,
                src_out_us: layer.params.src_out_us - placed.tailUs,
              };
        if (audio.lastParamsRef !== params || audio.lastRoleGain !== rGain) {
          const json =
            JSON.stringify(params) + `|${placed.tStartUs}|${placed.tEndUs}|${rGain}`;
          if (json !== audio.lastParamsJson) {
            audio.mixer.updateView(params, placed.tStartUs, placed.tEndUs, rGain);
            audio.lastParamsJson = json;
          }
          audio.lastParamsRef = params;
          audio.lastRoleGain = rGain;
        }
        tickedAudio.add(layer.id);
        audio.mixer.tick(tRootUs, playing, placed.tEndUs, anchor);
      }
    }
    // Mixers gated out above (track mute/solo/disable, layer disable)
    // would otherwise never tick again, leaving their pre-scheduled
    // chunks (≤ LOOKAHEAD_S ≈ 3 s) audible after the gate flips. Tick
    // them with pause semantics (playing=false, null anchor — the exact
    // branch a transport pause exercises) so the mixer's own teardown
    // stops every live node this frame.
    for (const [layerId, audio] of this.audios) {
      if (tickedAudio.has(layerId)) continue;
      audio.mixer.tick(tRootUs, false, this.pausedEndUs(layerId), null);
    }
    for (const [layerId, ref] of this.refs) {
      if (tickedRefs.has(layerId)) continue;
      ref.sprite.node.silenceAudio(tRootUs);
    }
  }

  /// The pause-shaped tick for every mixer below this node — a Group layer
  /// that left the window, or was disabled, goes quiet the same frame.
  silenceAudio(tRootUs: number): void {
    for (const [layerId, audio] of this.audios) {
      audio.mixer.tick(tRootUs, false, this.pausedEndUs(layerId), null);
    }
    for (const ref of this.refs.values()) ref.sprite.node.silenceAudio(tRootUs);
  }

  private pausedEndUs(layerId: string): number {
    const layer = this.layerById.get(layerId);
    return layer ? this.offsetUs + layer.t_end_us : 0;
  }

  /// Visual pass at LOCAL time `tUs` (already on the frame grid): rebuild the
  /// container from the layers active at `tUs`, in track order, each staged
  /// through `stageVisual`. Group layers composite their own node into a
  /// texture inside `updateCompositionRef`, before their sprite stages —
  /// so a nested texture is current when the parent's container renders.
  compositeVisual(tUs: number, effectOpts: EffectOpts): void {
    if (this.disposed) return;
    this.lastTUs = tUs;
    const tRebuild = stageNow();
    this.container.removeChildren();
    stageAdd(STAGE.SceneRebuild, tRebuild);

    // Two-input transition node: pick this frame's active windows, then let
    // the sweep divert participants through `stageVisual`. beginFrame also
    // runs when the active set is empty but nodes linger, so a just-finished
    // window returns its RTs to the pool that same frame.
    const activeTransitions = selectActiveTransitions(
      this.composition.transitions,
      tUs,
      (id) => this.layerById.get(id),
      (id) => this.trackEnabledByLayer.get(id) ?? false,
    );
    if (activeTransitions.length > 0 || this.transitionNodes?.hasNodes()) {
      (this.transitionNodes ??= new TransitionNodeManager(
        this.host.renderer!,
        this.width,
        this.height,
      )).beginFrame(activeTransitions);
    }

    let z = 0;
    const tSweep = stageNow();
    for (const track of this.composition.tracks) {
      if (!track.enabled) continue;
      for (const layer of track.layers) {
        if (!layer.enabled) continue;
        if (tUs < layer.t_start_us || tUs >= layer.t_end_us) continue;

        const kind = layer.params.kind;
        const tInLayerUs = tUs - layer.t_start_us;
        if (kind === "VideoClip") {
          const clip = this.ensureClip(layer);
          if (!clip) continue;
          this.updateClip(clip, layer, tUs, z++);
          this.stageVisual(clip.sprite, clip.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "ImageOverlay") {
          const image = this.ensureImage(layer);
          if (!image) continue;
          this.updateImage(image, layer, tUs, z++);
          this.stageVisual(image.sprite, image.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "Color") {
          const color = this.ensureColor(layer);
          if (!color) continue;
          this.updateColor(color, layer, z++, tInLayerUs);
          this.stageVisual(color.sprite, color.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "Text") {
          const text = this.ensureText(layer);
          if (!text) continue;
          this.updateText(text, layer, z++, tUs);
          this.stageVisual(text.sprite, text.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "Motif") {
          const tmpl = this.ensureMotif(layer);
          if (!tmpl) continue;
          this.updateMotif(tmpl, layer, z++, tUs);
          this.stageVisual(tmpl.sprite, tmpl.effects, layer, tInLayerUs, effectOpts);
        } else if (kind === "CompositionRef") {
          const ref = this.ensureCompositionRef(layer);
          if (!ref) continue;
          this.updateCompositionRef(ref, layer, z++, tInLayerUs, effectOpts);
          this.stageVisual(ref.sprite, ref.effects, layer, tInLayerUs, effectOpts);
        }
      }
    }
    stageAdd(STAGE.LayerSweep, tSweep);
    // Bake diverted sides into their RTs + publish progress, after the sweep
    // (so any branch's staging is caught) and before the container renders
    // (so the quad samples THIS frame's pixels).
    this.transitionNodes?.finishFrame();
  }

  /// Nothing to show (the Group's window runs past its composition): an
  /// empty container, and the transition node's RTs back in the pool.
  compositeNothing(): void {
    if (this.disposed) return;
    this.container.removeChildren();
    if (this.transitionNodes?.hasNodes()) this.transitionNodes.beginFrame([]);
  }

  /// Per-frame "filter + addChild" tail for every visual layer kind. Applies
  /// the layer's resolved effect filters, then stages the node once it's ready.
  /// All six visual kinds — Group included — carry an EffectChain; `effects`
  /// stays optional only as a defensive no-op (a chain-less caller would stage
  /// unfiltered).
  private stageVisual(
    sprite: StageableSprite,
    effects: EffectChain | undefined,
    layer: LayerSummary,
    tInLayerUs: number,
    effectOpts: EffectOpts,
  ): void {
    if (effects) {
      const tEffects = stageNow();
      sprite.displayObject.filters = effectsFor(effects, layer, tInLayerUs, effectOpts);
      stageAdd(STAGE.Effects, tEffects);
    }
    // Transition divert: a participant's finished node — transform, opacity,
    // and filters exactly as the normal path would stage them — goes into its
    // side's offscreen container (baked to an RT in `finishFrame`) instead of
    // the stage; the two-input quad stands in at the FIRST participant's
    // stage position. See transitions/TransitionNodes.ts.
    const side = this.transitionNodes?.sideFor(layer.id);
    if (side) {
      if (sprite.stageReady) side.addChild(sprite.displayObject);
      const quad = this.transitionNodes!.takeQuadToStage(layer.id);
      if (quad) this.container.addChild(quad);
      return;
    }
    // Skip not-yet-ready sprites. Sprite-backed kinds report stageReady false
    // while their texture is still the EMPTY placeholder — PixiJS v8's batched
    // renderer crashes on that placeholder in some Chromium configs. Once the
    // first frame lands, the texture swaps and the sprite stages.
    if (sprite.stageReady) {
      this.container.addChild(sprite.displayObject);
    }
  }

  // ============================================================
  // Tick-side queries the Compositor forwards
  // ============================================================

  /// Point every active decode session at the source time LOCAL `tUs` maps to,
  /// recursing into Group layers under the playhead.
  anchor(tUs: number): void {
    for (const c of this.clips.values()) {
      const layer = this.layerById.get(c.layerId);
      if (!layer || layer.params.kind !== "VideoClip") continue;
      // Mirror compositeVisual's window check. `this.clips` retains every
      // clip that's ever been active (pruned only in `setComposition` on layer
      // delete); without this filter every accumulated entry would fire
      // `requestFrameAt` each tick for time-regions the user isn't viewing,
      // churning the decoder + ring.
      if (tUs < layer.t_start_us || tUs >= layer.t_end_us) continue;
      // Stale handle (pool reclaimed during idle): skip this tick.
      // The next `compositeVisual` runs immediately after this and its
      // `ensureClip` swaps in a fresh source; the tick after that
      // will see the revived handle here.
      if (c.source.disposed) continue;
      const layerLocalUs = tUs - layer.t_start_us;
      const srcTUs = layer.params.src_in_us + layerLocalUs;
      void c.source.requestFrameAt(srcTUs);
    }
    for (const ref of this.refs.values()) {
      const layer = this.layerById.get(ref.layerId);
      if (!layer || layer.params.kind !== "CompositionRef") continue;
      if (tUs < layer.t_start_us || tUs >= layer.t_end_us) continue;
      ref.sprite.node.anchor(tUs - layer.t_start_us + layer.params.src_in_us);
    }
  }

  /// True if every active VideoClip at LOCAL `tUs` — this node's and those in
  /// Group layers under the playhead — has its frame plus `minLookaheadUs` of
  /// ring past it. True with no active clip at all.
  hasLookaheadAt(tUs: number, minLookaheadUs: number): boolean {
    for (const c of this.clips.values()) {
      const layer = this.layerById.get(c.layerId);
      if (!layer || layer.params.kind !== "VideoClip") continue;
      if (tUs < layer.t_start_us || tUs >= layer.t_end_us) continue;
      const layerLocalUs = tUs - layer.t_start_us;
      const srcTUs = layer.params.src_in_us + layerLocalUs;
      const ring = c.source.ring;
      if (!ring.containsPts(srcTUs)) return false;
      const last = ring.lastPtsUs();
      if (last === null || last < srcTUs + minLookaheadUs) return false;
    }
    for (const ref of this.refs.values()) {
      const layer = this.layerById.get(ref.layerId);
      if (!layer || layer.params.kind !== "CompositionRef") continue;
      if (tUs < layer.t_start_us || tUs >= layer.t_end_us) continue;
      if (!ref.sprite.node.hasLookaheadAt(tUs - layer.t_start_us + layer.params.src_in_us, minLookaheadUs)) {
        return false;
      }
    }
    return true;
  }

  /// End of the last piece of playable material in THIS composition — the
  /// maximum `t_end_us` across enabled layers in enabled tracks; 0 with none.
  /// A Group layer bounds its content, so no recursion.
  playableEndUs(): number {
    let end = 0;
    for (const t of this.composition.tracks) {
      if (!t.enabled) continue;
      for (const l of t.layers) {
        if (!l.enabled) continue;
        if (l.t_end_us > end) end = l.t_end_us;
      }
    }
    return end;
  }

  /// Every live (non-disposed) clip below this node, this node's first.
  forEachClip(f: (clip: { layerId: string; mediaId: string; source: DecodeSession }) => void): void {
    for (const c of this.clips.values()) {
      if (c.source.disposed) continue;
      f(c);
    }
    for (const ref of this.refs.values()) ref.sprite.node.forEachClip(f);
  }

  /// PerfHUD rows for every live clip below this node.
  clipPerfRows(out: ClipPerfRow[]): void {
    this.forEachClip((c) => {
      const ring = c.source.ring;
      out.push({
        layerId: c.layerId,
        mediaId: c.mediaId,
        decodeQueueSize: c.source.decodeQueueSize?.() ?? 0,
        ringSize: ring.size(),
        ringFirstPtsUs: ring.firstPtsUs(),
        ringLastPtsUs: ring.lastPtsUs(),
        decodedFrameCount: c.source.decodedFrameCount?.() ?? 0,
        sourceKind: sourceKindOf(c.source),
        downgraded: c.source.isDowngraded?.() ?? false,
        handoff: c.source.handoffTimings?.() ?? null,
        lookaheadFull: c.source.isLookaheadFull?.() ?? false,
        ringFate: ring.fate ?? null,
        conversionBacklog: c.source.conversionBacklog?.() ?? null,
      });
    });
  }

  /// Transition node + RT-pool accounting for this node's own manager; null
  /// until its first active window.
  transitionStats(): ReturnType<TransitionNodeManager["stats"]> | null {
    return this.transitionNodes?.stats() ?? null;
  }

  swapsInFlight(): number {
    let n = this.swaps.size;
    for (const ref of this.refs.values()) n += ref.sprite.node.swapsInFlight();
    return n;
  }

  /// The untransformed content size of a live layer of THIS composition, in
  /// composition pixels — what the on-canvas gizmo builds its box from. Null
  /// when the layer has no staged sprite yet (off-playhead, or still decoding
  /// its first frame).
  ///
  /// Per-kind source, and why it is not one uniform `getBounds()` call: a
  /// VideoClip's scale is source-corrected (`media/texture`, so proxies preview
  /// at original size), which makes the MEDIA dimensions its natural size;
  /// Image/Motif scale their decoded raster directly; Text has no intrinsic
  /// size at all, so `TextSprite.naturalSize` answers with its layout box when
  /// one is set and the measured glyph bounds otherwise — the sprite owns that
  /// choice so the rectangle drawn is the rectangle being dragged; a Group is
  /// its composition's frame. `getBounds()` would also fold in filter padding
  /// and draw an oversized box on a blurred layer.
  naturalSizeOf(layerId: string): { w: number; h: number } | null {
    const clip = this.clips.get(layerId);
    if (clip) {
      const media = this.host.mediaById(clip.mediaId);
      if (media?.width && media.height) return { w: media.width, h: media.height };
      return textureSize(clip.sprite.sprite.texture);
    }
    const image = this.images.get(layerId);
    if (image) return textureSize(image.sprite.sprite.texture);
    const motif = this.activeMotifs.get(layerId);
    if (motif) return textureSize(motif.sprite.sprite.texture);
    const text = this.texts.get(layerId);
    if (text) return text.sprite.naturalSize();
    const ref = this.refs.get(layerId);
    if (ref) return ref.sprite.naturalSize();
    return null;
  }

  /// What the staged Text sprite did with its font size (`GizmoProbe.textFitOf`).
  /// Null for every other kind and for a Text layer not currently staged — the
  /// shrink factor is derived per-render and there is nothing to report about a
  /// layer that has not rendered.
  textFitOf(layerId: string): TextFit | null {
    return this.texts.get(layerId)?.sprite.fit() ?? null;
  }

  /// E2E-only (preview-sw conformance): snapshot the decode source + bound
  /// sprite of the active VideoClip named by `layerId` (or the first live
  /// clip when omitted), searching Group layers' nodes after this one's.
  /// Returns null when no matching clip is active. Read-only — never mutates
  /// node state.
  activeClipProbe(layerId?: string): ActiveClipProbe | null {
    let clip: ActiveClip | undefined;
    if (layerId != null) {
      clip = this.clips.get(layerId);
    } else {
      for (const c of this.clips.values()) {
        if (!c.source.disposed) {
          clip = c;
          break;
        }
      }
    }
    if (!clip) {
      for (const ref of this.refs.values()) {
        const hit = ref.sprite.node.activeClipProbe(layerId);
        if (hit) return hit;
      }
      return null;
    }
    const s = clip.source;
    const sourceKind = sourceKindOf(s);
    const tex = clip.sprite.sprite.texture;
    const isEmpty = tex === Texture.EMPTY;
    return {
      layerId: clip.layerId,
      mediaId: clip.mediaId,
      sourceKind,
      isSoftware: sourceKind === "sw",
      sourceDisposed: s.disposed,
      ringSize: s.ring.size(),
      ringFirstPtsUs: s.ring.firstPtsUs(),
      ringLastPtsUs: s.ring.lastPtsUs(),
      ringFate: s.ring.fate ?? null,
      spriteBound: !isEmpty,
      spriteWidth: isEmpty ? 0 : tex.orig.width,
      spriteHeight: isEmpty ? 0 : tex.orig.height,
      boundFramePtsUs: clip.boundFramePtsUs,
      boundFrameDurationUs: clip.boundFrameDurationUs,
      boundFrameSourceKey: clip.boundFrameSourceKey,
      boundFrameKind: clip.boundFrameKind,
      hwLane: s instanceof FfmpegSource ? s.currentHwLane() : null,
      builtFromKey: clip.builtFromKey,
    };
  }

  /// Refresh every live Motif sprite below this node against the current
  /// runtime catalog. No sprite is recreated (refreshMotif keeps the last
  /// bitmap until the fresh capture lands).
  refreshMotifs(): void {
    for (const { sprite } of this.activeMotifs.values()) sprite.refreshMotif();
    for (const ref of this.refs.values()) ref.sprite.node.refreshMotifs();
  }

  /// Open the boundary clip's decode session ahead of the playhead (preview).
  /// Returns null when the clip cannot be built or its handle is stale.
  prewarmClip(layer: LayerSummary): DecodeSession | null {
    const clip = this.ensureClip(layer);
    if (!clip || clip.source.disposed) return null;
    return clip.source;
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /// Drop every decode-holding resource below this node — sessions, mixers,
  /// swaps, transition RTs — keeping the sprite maps' other kinds. The next
  /// sweep re-acquires through the normal `ensureClip` path. The pool itself
  /// is the Compositor's to dispose.
  suspend(): void {
    for (const c of this.clips.values()) {
      c.sprite.dispose();
      c.effects.dispose();
    }
    this.clips.clear();
    for (const a of this.audios.values()) a.mixer.dispose();
    this.audios.clear();
    this.container.removeChildren();
    this.cancelAllSwaps();
    this.transitionNodes?.reset();
    for (const ref of this.refs.values()) ref.sprite.node.suspend();
  }

  /// Release every sprite, mixer, session and child node. The container is
  /// destroyed only when this node created it — a lent one (the Compositor's
  /// stage) is emptied and handed back.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [layerId, c] of this.clips) this.evictClip(layerId, c);
    this.clips.clear();
    for (const i of this.images.values()) { i.sprite.dispose(); i.effects.dispose(); }
    this.images.clear();
    this.imageLoadPromises.clear();
    for (const c of this.colors.values()) { c.sprite.dispose(); c.effects.dispose(); }
    this.colors.clear();
    for (const t of this.texts.values()) { t.sprite.dispose(); t.effects.dispose(); }
    this.texts.clear();
    for (const t of this.activeMotifs.values()) { t.sprite.dispose(); t.effects.dispose(); }
    this.activeMotifs.clear();
    for (const r of this.refs.values()) { r.sprite.dispose(); r.effects.dispose(); }
    this.refs.clear();
    for (const a of this.audios.values()) a.mixer.dispose();
    this.audios.clear();
    this.cancelAllSwaps();
    this.transitionNodes?.dispose();
    this.transitionNodes = null;
    try {
      this.container.removeChildren();
      if (this.ownsContainer) this.container.destroy({ children: true });
    } catch {
      // Renderer may already be gone; ignore.
    }
  }

  /// Tear down one clip and release its decode session, not just its sprite.
  /// Without the release the pool holds the handle — and on the ffmpeg
  /// hardware lane its GPU session — until the idle sweep notices seconds
  /// later, so a clip resolving in that window is measured against layers the
  /// user already deleted and can lose a session/area reservation to a ghost.
  /// That loss is permanent: the lane is picked once per source
  /// (docs/preview.md). It costs the idle sweep's undo grace, which is the
  /// better trade — a warm re-decode is a second, a phantom downgrade lasts
  /// the session.
  /// LANDMINE: release BOTH pool keys. `abandonSwap` covers a swap still in
  /// flight, but a COMPLETED one left `clip.source` under `${key}#swap` with
  /// the base key already released, so asking only for `key` would leak the
  /// handle that is actually decoding. `release` no-ops on a miss, so asking
  /// for both is safe in either state.
  private evictClip(layerId: string, c: ActiveClip): void {
    this.abandonSwap(layerId);
    this.host.releaseIngest(c.key);
    this.host.pool.release(c.key);
    this.host.pool.release(swapKeys(c.key, c.mediaId).swapLayerId);
    c.sprite.dispose();
    c.effects.dispose();
    this.clips.delete(layerId);
  }

  // ============================================================
  // VideoClip
  // ============================================================

  private ensureClip(layer: LayerSummary): ActiveClip | null {
    if (layer.params.kind !== "VideoClip") return null;
    const host = this.host;
    const key = this.keyFor(layer.id);
    const existing = this.clips.get(layer.id);
    // The cached `source` may be a disposed handle — the pool's idle sweep
    // reclaims any clip the playhead isn't feeding (see `SourceDecoderPool`).
    // Fall through and re-acquire when it is.
    if (existing && !existing.source.disposed) {
      // No-flash re-resolution: when the resolver's IDENTITY for this media
      // changes (a proxy landed, the engine flipped, or a runtime ffmpeg
      // failure), begin an overlap-swap; keep returning the existing clip so
      // the current frame stays on screen until the new handle holds the
      // visible frame (key semantics: `ResolvedRendererSource`). Only a fully
      // resolved ("ok") result is swap-worthy; a still-"pending" re-resolve
      // leaves the existing clip alone.
      if (host.mode === "preview") {
        const rs = host.resolveSource(layer.params.media_id);
        if (rs?.status === "unsupported") {
          // The resolved engine flipped to one that CANNOT decode this original
          // (e.g. decode_engine → Lite/webcodecs on a ProRes clip already built
          // under ffmpeg, once the sticky WebCodecs-unusable mark lands). Tear
          // the stale clip down and record the media so the Compositor fires
          // `onUnsupported` and the UnsupportedClipCard surfaces — otherwise the
          // clip would sit on screen forever with no card. Mirrors the fresh-
          // acquire unsupported path (and the teardown in `setComposition`).
          this.evictClip(layer.id, existing);
          host.noteUnsupported(layer.params.media_id);
          return null;
        }
        if (rs?.status === "ok" && rs.key !== null && rs.key !== existing.builtFromKey) {
          this.beginSwap(existing, layer, rs);
        }
      }
      return existing;
    }
    const mediaId = layer.params.media_id;
    // Preview resolves the decode engine once here (ffmpeg vs webcodecs ×
    // original vs proxy); export keeps its single proxy path, wrapped by
    // `rsFromExportProxy` in the same shape so this acquire path is shared.
    const rs =
      host.mode === "preview"
        ? host.resolveSource(mediaId)
        : rsFromExportProxy(host.proxyAssetUrl(mediaId));
    if (!rs) {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/pixi] no decode source for media ${mediaId} (clip ${key})`);
      return null;
    }
    if (rs.status === "unsupported") {
      // No engine can decode this media — record it and skip the clip. Only
      // ADD here; reset + fire are the Compositor's job (see its
      // `unsupportedMedia`). Export never wires `onUnsupported`, so the add
      // is inert there.
      host.noteUnsupported(mediaId);
      return null;
    }
    if (rs.status !== "ok" || rs.target === null) {
      // Pending: proxy still building, or webcodecs decodability untested.
      // The next resolution (probe settling / proxy landing) will retry.
      return null;
    }
    // Color tags apply to ANY decode target for this media — a proxy
    // preserves the source's colorimetry (see `CompositorInit.sourceColor`).
    const sourceColor = host.sourceColor(mediaId);
    const m = host.mediaById(mediaId);
    const sourceStartPtsUs = m?.video_start_pts_us ?? m?.start_pts_us ?? null;
    // Swap/revival identity (engine + source + decode target). Non-null: the
    // guard above returned unless status is "ok" with a non-null target, and
    // the resolver only nulls `key` when `target` is null.
    const builtFromKey = rs.key!;
    // Export pool keying: must match the Worker's per-(media, phase) grouping
    // so this sprite reads the ring the Worker is filling. The Worker keys
    // off the walk's ROOT-time placement (compositionWalk.ts), so a clip
    // inside a Group is placed the same way here. Preview keys by the
    // instance key and ignores handleKey.
    const placed = placeLayer(layer, this.offsetUs, this.windowStartUs, this.windowEndUs);
    const source = host.pool.acquire({
      layerId: key,
      mediaId,
      ...(host.mode === "export"
        ? {
            handleKey: exportHandleKey(
              mediaId,
              layer.params.src_in_us + placed.headUs,
              placed.tStartUs,
            ),
          }
        : {}),
      sourceColor,
      sourceStartPtsUs,
      engine: rs.engine,
      // WebCodecs decodes this URL; ffmpeg ignores it and decodes
      // `sourcePath` directly (spread below).
      proxyAssetUrl: rs.engine === "webcodecs" ? rs.target! : "",
      ...(rs.engine === "ffmpeg"
        ? {
            sourcePath: rs.target!,
            codec: m?.codec ?? null,
            pixFmt: m?.pix_fmt ?? null,
            width: m?.width ?? null,
            height: m?.height ?? null,
            // Always true here: the resolver only returns engine "ffmpeg" +
            // status "ok" when the ffmpeg component is loaded (see
            // `resolveDecodeEngine`'s "ffmpeg" and "auto" branches).
            componentAvailable: true,
          }
        : {}),
    });
    // Subscribe to the first-frame notification BEFORE kicking off
    // ensureReady so we don't miss the synchronous-fire case if the
    // source happened to be pre-warmed by another clip referencing
    // the same media.
    source.onFirstFrame(() => {
      host.scheduleRepaint();
    });
    // Sticky runtime failure: an ffmpeg-engine handle that dies at runtime
    // (GPU decode error, device loss, session crash, budget-rejected open)
    // fires `onFatalError`. Mark the engine unusable for this media (sticky
    // this session — `isFfmpegUnusable`) and repaint: the next `ensureClip`
    // re-resolves, so "auto" falls through to webcodecs and a pinned "ffmpeg"
    // resolves "unsupported". Either way the key changes and the no-flash
    // swap rebuilds onto the new source. WebCodecs' `SourceHandle` has no
    // `onFatalError` (it downgrades to software internally) — no-op there.
    if (source.onFatalError) {
      source.onFatalError((reason) => {
        markFfmpegUnusable(mediaId, reason);
        host.scheduleRepaint();
      });
    }
    // Kick off the async ensureReady. After it resolves, the next
    // anchor tick (or first decoded frame's onFirstFrame callback) will paint.
    void source.ensureReady().catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[weftcut/pixi] ensureReady ${mediaId} failed`, e);
    });
    if (existing) {
      // Revival path: keep the sprite (the bound texture from the
      // last paint is still visible on the canvas, so the user sees
      // a held frame rather than a flash to EMPTY while the new
      // decoder warms up), just swap in the fresh source.
      existing.source = source;
      existing.builtFromKey = builtFromKey;
      existing.loggedNull = false;
      return existing;
    }
    const sprite = new VideoClipSprite({ layerId: key, mediaId });
    const clip: ActiveClip = {
      layerId: layer.id,
      key,
      mediaId,
      source,
      sprite,
      effects: new EffectChain(),
      builtFromKey,
      boundFramePtsUs: null,
      boundFrameDurationUs: null,
      boundFrameSourceKey: null,
      boundFrameKind: null,
      loggedNull: false,
    };
    this.clips.set(layer.id, clip);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] clip ${key} → media ${mediaId} attached`);
    return clip;
  }

  /// Begin a no-flash overlap-swap of `clip` to a second handle decoding the
  /// freshly-resolved source `rs`. The original stays referenced by
  /// `clip.source` (so the preview never blanks) until `pollSwap` confirms the
  /// new handle's ring holds the visible frame, at which point `completeSwap`
  /// repoints atomically. `rs` may resolve to either engine — an ffmpeg
  /// `sourcePath` or a WebCodecs URL — so a runtime ffmpeg failure
  /// (`markFfmpegUnusable`) rides this same path.
  private beginSwap(clip: ActiveClip, layer: LayerSummary, rs: ResolvedRendererSource): void {
    if (layer.params.kind !== "VideoClip") return;
    if (!rs.key) return;
    const inflight = this.swaps.get(clip.layerId);
    if (inflight) {
      // Already swapping to this identity → leave it. Otherwise the target
      // changed (or the handle died) → abandon and restart toward `rs`.
      if (!inflight.handle.disposed && inflight.key === rs.key) return;
      this.abandonSwap(clip.layerId);
    }
    const { swapLayerId, swapMediaId } = swapKeys(clip.key, clip.mediaId);
    // Resolve color/start/codec facts against the REAL media (`clip.mediaId`)
    // even though the handle is acquired under the synthetic `swapMediaId`
    // (a proxy preserves source color — `CompositorInit.sourceColor`).
    const sourceColor = this.host.sourceColor(clip.mediaId);
    const m = this.host.mediaById(clip.mediaId);
    const sourceStartPtsUs = m?.video_start_pts_us ?? m?.start_pts_us ?? null;
    const handle = this.host.pool.acquire({
      layerId: swapLayerId,
      mediaId: swapMediaId,
      sourceColor,
      sourceStartPtsUs,
      engine: rs.engine,
      proxyAssetUrl: rs.engine === "webcodecs" ? rs.target! : "",
      ...(rs.engine === "ffmpeg"
        ? {
            sourcePath: rs.target!,
            codec: m?.codec ?? null,
            pixFmt: m?.pix_fmt ?? null,
            width: m?.width ?? null,
            height: m?.height ?? null,
            componentAvailable: true,
          }
        : {}),
    });
    const state: SwapState = { handle, swapLayerId, key: rs.key, timer: null, deadline: null };
    this.swaps.set(clip.layerId, state);
    void handle.ensureReady().catch(() => {
      this.abandonSwap(clip.layerId);
    });
    // `onFirstFrame` is one-shot and usually fires on the GOP key (before the
    // target frame), so it can't carry the swap to completion alone. Drive it
    // with a bounded poll that also keeps the swap handle warm against the
    // idle sweeper; a deadline abandons a swap that never produces the frame.
    const poll = () => this.pollSwap(clip.layerId);
    handle.onFirstFrame(poll);
    state.timer = setInterval(poll, 120);
    state.deadline = setTimeout(() => this.abandonSwap(clip.layerId), 8000);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] begin source-swap ${clip.key} → ${rs.key}`);
  }

  /// Poll an in-flight swap: nudge the new handle toward the current frame and
  /// complete once that frame is decoded. No-op once the swap is gone.
  private pollSwap(layerId: string): void {
    const state = this.swaps.get(layerId);
    if (!state) return;
    const clip = this.clips.get(layerId);
    const layer = this.layerById.get(layerId);
    if (!clip || !layer || layer.params.kind !== "VideoClip" || state.handle.disposed) {
      this.abandonSwap(layerId);
      return;
    }
    const tUsSnapped = snapFrameFloor(this.lastTUs, this.host.fpsNum(), this.host.fpsDen());
    // Playhead off this clip → can't prove the proxy has the visible frame
    // yet; keep the original and retry on a later tick.
    if (tUsSnapped < layer.t_start_us || tUsSnapped >= layer.t_end_us) return;
    const srcTUs = layer.params.src_in_us + (tUsSnapped - layer.t_start_us);
    void state.handle.requestFrameAt(srcTUs);
    if (state.handle.ring.frameAt(srcTUs) != null) {
      this.completeSwap(layerId, srcTUs);
    }
  }

  /// Atomically repoint `clip.source` to the swap handle (whose ring now holds
  /// the frame at `srcTUs`) and release the original. Never swaps to an empty
  /// ring — that black frame is exactly what this avoids.
  private completeSwap(layerId: string, srcTUs: number): void {
    const state = this.swaps.get(layerId);
    const clip = this.clips.get(layerId);
    if (!state) return;
    if (!clip) {
      this.abandonSwap(layerId);
      return;
    }
    if (state.handle.ring.frameAt(srcTUs) == null) return; // lost the frame; wait
    const old = clip.source;
    clip.source = state.handle;
    clip.builtFromKey = state.key;
    this.clearSwapTimers(state);
    this.swaps.delete(layerId);
    // Release the ORIGINAL handle by its pool key. The swap handle now lives
    // under `${key}#swap`, referenced by `clip.source` and kept warm by
    // `anchor`'s per-tick requests.
    if (!old.disposed) this.host.pool.release(clip.key);
    this.host.scheduleRepaint();
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] completed source-swap ${clip.key} → ${state.key}`);
  }

  /// Tear down an in-flight swap without repointing: clear its timers and
  /// release the synthetic swap handle. The clip keeps its original source.
  private abandonSwap(layerId: string): void {
    const state = this.swaps.get(layerId);
    if (!state) return;
    this.clearSwapTimers(state);
    this.swaps.delete(layerId);
    this.host.pool.release(state.swapLayerId);
  }

  private clearSwapTimers(state: SwapState): void {
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (state.deadline !== null) {
      clearTimeout(state.deadline);
      state.deadline = null;
    }
  }

  /// Clear every in-flight swap's timers and forget them. Used by
  /// suspend/dispose, where the pool is disposed wholesale so the synthetic
  /// handles don't need a per-key release.
  private cancelAllSwaps(): void {
    for (const s of this.swaps.values()) this.clearSwapTimers(s);
    this.swaps.clear();
  }

  private updateClip(clip: ActiveClip, layer: LayerSummary, tUs: number, z: number): void {
    if (layer.params.kind !== "VideoClip") return;

    const layerLocalUs = tUs - layer.t_start_us;
    // Per-frame keyframe resolution: AnimTrack views -> scalars at the
    // layer-local time. Identical in preview and the export Worker.
    const params = withTransformOverride(
      layer.id,
      resolveVideoClipView(layer.params, layerLocalUs),
    );
    const srcTUs = params.src_in_us + layerLocalUs;

    const media = this.host.mediaById(params.media_id);

    // Upload the current frame BEFORE adjusting transforms so the
    // sprite's natural size reflects the real texture dimensions.
    const tRing = stageNow();
    const selected = clip.source.ring.selectFrame(srcTUs);
    stageAdd(STAGE.RingLookup, tRing);
    const frame = selected?.frame ?? null;

    // Underrun accounting: while the master clock runs, a stale or
    // missing frame here is a dropped frame the free-running playhead
    // glossed over. Swap-in-flight clips are exempt — the no-flash
    // source swap deliberately holds the old pixels while the new
    // source's ring fills (see `SwapState`).
    if (
      this.host.mode === "preview" &&
      this.host.playing() &&
      !this.host.scrubbing() &&
      !this.swaps.has(clip.layerId)
    ) {
      const verdict = judgeFrameSelection({
        selectedPtsUs: selected?.ptsUs ?? null,
        selectedDurationUs: selected?.durationUs ?? 0,
        srcTUs,
        mediaDurationUs: media?.duration_us ?? null,
      });
      if (verdict === "late") this.host.noteLateLayer();
    }
    if (frame && selected) {
      if (isTenBitFrame(frame)) {
        const tTenBit = stageNow();
        const texture = this.host.ensureTenBitIngest().textureFor(clip.key, frame);
        stageAdd(STAGE.TenBitIngest, tTenBit);
        clip.sprite.bindExternalTexture(texture);
        clip.boundFrameKind = "p10";
      } else if (isNativeNv12Frame(frame)) {
        // Native 8-bit CPU-plane frames (export relay AND the SW preview
        // lane) convert in OUR shader — Chromium's software conversion of
        // buffer-defined NV12 VideoFrames applies BT.601 regardless of the
        // stamped colorSpace (see nv12Frame.ts).
        const tNv12 = stageNow();
        const texture = this.host.ensureNv12Ingest().textureFor(clip.key, frame);
        stageAdd(STAGE.Nv12Ingest, tNv12);
        clip.sprite.bindExternalTexture(texture);
        clip.boundFrameKind = "nv12";
      } else {
        const tUpload = stageNow();
        clip.sprite.updateFrame(frame);
        stageAdd(STAGE.BitmapUpload, tUpload);
        clip.boundFrameKind = "browser";
      }
      clip.boundFramePtsUs = selected.ptsUs;
      clip.boundFrameDurationUs = selected.durationUs;
      clip.boundFrameSourceKey = clip.builtFromKey;
    } else {
      // Diagnostic: log when `selectFrame` returns null (painter holds
      // previous frame). Throttled to "only when this clip's state
      // transitions from has-frame to null" to avoid spamming during
      // a long null window.
      if (clip.sprite.sprite.texture !== Texture.EMPTY && !clip.loggedNull) {
        clip.loggedNull = true;
        // eslint-disable-next-line no-console
        console.log(
          `[weftcut/pixi] frameAt(${srcTUs}) → null for ${clip.key} ` +
            `(ringFirst=${clip.source.ring.firstPtsUs()} ` +
            `ringLast=${clip.source.ring.lastPtsUs()})`,
        );
      }
    }
    if (frame) clip.loggedNull = false;

    // Keep transform semantics tied to the original media dimensions, not
    // the currently decoded proxy dimensions. Quick proxies may be 540p and
    // full proxies are capped at 1080p; both should preview at the same size
    // as the source would. Avoid Pixi's width/height setters because they
    // derive scale from `Texture.EMPTY` before the first frame lands.
    const tex = clip.sprite.sprite.texture;
    const textureW = tex === Texture.EMPTY ? null : tex.orig.width;
    const textureH = tex === Texture.EMPTY ? null : tex.orig.height;
    const sourceScaleX =
      media?.width && textureW && textureW > 0 ? media.width / textureW : 1;
    const sourceScaleY =
      media?.height && textureH && textureH > 0 ? media.height / textureH : 1;
    const effScaleX = params.scale_x * sourceScaleX;
    const effScaleY = params.scale_y * sourceScaleY;
    clip.sprite.sprite.scale.set(
      effScaleX * (params.flip_h ? -1 : 1),
      effScaleY * (params.flip_v ? -1 : 1),
    );
    // Anchor is the pivot: rotation and flip turn around it while `x`/`y` keep
    // meaning the unrotated top-left (anchorPivot.ts). The pivot is in TEXTURE
    // space, so it must use the decoded dimensions while the position
    // compensation uses the effective (source-corrected) scale.
    const pivot = anchorPivot({
      x: params.x,
      y: params.y,
      anchorX: params.anchor_x,
      anchorY: params.anchor_y,
      texW: textureW,
      texH: textureH,
      effScaleX,
      effScaleY,
    });
    clip.sprite.sprite.pivot.set(pivot.pivotX, pivot.pivotY);
    clip.sprite.sprite.position.set(pivot.posX, pivot.posY);
    clip.sprite.sprite.angle = params.rotation_deg;
    clip.sprite.sprite.alpha = params.opacity;
    clip.sprite.sprite.zIndex = z;
  }

  // ============================================================
  // ImageOverlay
  // ============================================================

  private ensureImage(layer: LayerSummary): ActiveImage | null {
    if (layer.params.kind !== "ImageOverlay") return null;
    const existing = this.images.get(layer.id);
    if (existing) return existing;
    const mediaId = layer.params.media_id;
    const url = this.host.originalAssetUrl(mediaId);
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/pixi] no asset URL for media ${mediaId} (image ${layer.id})`,
      );
      return null;
    }
    const sprite = new ImageOverlaySprite({
      layerId: layer.id,
      mediaId,
      maxWidth: this.width,
      maxHeight: this.height,
    });
    const loadPromise = sprite.loadFromAsset(url).then(() => {
      // Trigger a repaint once the bitmap lands.
      this.host.scheduleRepaint();
      // Identity-checked, never key-only: a stale completion (this sprite was
      // evicted and the layer re-ensured while the load was in flight) must
      // not delete the NEW sprite's reservation — `preloadImages` would then
      // see nothing pending and the export frame loop would race the
      // still-loading bitmap into a transparent image layer. Same ABA the
      // AudioMixer's identity-owned chunk slots close.
      if (this.imageLoadPromises.get(layer.id) === loadPromise) {
        this.imageLoadPromises.delete(layer.id);
      }
    });
    this.imageLoadPromises.set(layer.id, loadPromise);
    void loadPromise;
    const image: ActiveImage = { layerId: layer.id, mediaId, sprite, effects: new EffectChain() };
    this.images.set(layer.id, image);
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/pixi] image ${layer.id} → media ${mediaId} attached`,
    );
    return image;
  }

  /// Pre-trigger image loading for every ImageOverlay layer below this node
  /// and return a promise that resolves once ALL are loaded. Group layers get
  /// their node built here whatever the time, so their images load too. Called
  /// by the export Worker before the frame loop so that animated GIF frames
  /// are available before compositing begins (ensureImage fires loadFromAsset
  /// as fire-and-forget; without this wait the decoder races the frame loop
  /// and all frames composite as transparent).
  async preloadImages(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const track of this.composition.tracks) {
      for (const layer of track.layers) {
        if (layer.params.kind === "ImageOverlay") {
          // Force-create sprites for any not yet ensured (the sweep would do
          // this lazily, but we want the load promises in flight immediately).
          this.ensureImage(layer);
          const p = this.imageLoadPromises.get(layer.id);
          if (p) pending.push(p);
        } else if (layer.params.kind === "CompositionRef") {
          const ref = this.ensureCompositionRef(layer);
          if (ref) pending.push(ref.sprite.node.preloadImages());
        }
      }
    }
    if (pending.length > 0) await Promise.all(pending);
  }

  private updateImage(
    image: ActiveImage,
    layer: LayerSummary,
    tUs: number,
    z: number,
  ): void {
    if (layer.params.kind !== "ImageOverlay") return;
    const tInLayerUs = tUs - layer.t_start_us;
    const durationUs = layer.t_end_us - layer.t_start_us;
    const params = withTransformOverride(
      layer.id,
      resolveImageOverlayView(layer.params, tInLayerUs),
    );
    image.sprite.update(params, tInLayerUs, durationUs);
    image.sprite.sprite.zIndex = z;
  }

  // ============================================================
  // Color
  // ============================================================

  private ensureColor(layer: LayerSummary): ActiveColor | null {
    if (layer.params.kind !== "Color") return null;
    const existing = this.colors.get(layer.id);
    if (existing) return existing;
    const sprite = new ColorSprite({ layerId: layer.id });
    const color: ActiveColor = { layerId: layer.id, sprite, effects: new EffectChain() };
    this.colors.set(layer.id, color);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] color ${layer.id} attached`);
    return color;
  }

  private updateColor(color: ActiveColor, layer: LayerSummary, z: number, tInLayerUs: number): void {
    if (layer.params.kind !== "Color") return;
    color.sprite.update(resolveColorView(layer.params, tInLayerUs));
    color.sprite.graphics.zIndex = z;
  }

  // ============================================================
  // Text
  // ============================================================

  private ensureText(layer: LayerSummary): ActiveText | null {
    if (layer.params.kind !== "Text") return null;
    const existing = this.texts.get(layer.id);
    if (existing) return existing;
    const sprite = new TextSprite({ layerId: layer.id });
    const text: ActiveText = { layerId: layer.id, sprite, effects: new EffectChain() };
    this.texts.set(layer.id, text);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] text ${layer.id} attached`);
    return text;
  }

  private updateText(text: ActiveText, layer: LayerSummary, z: number, tUs: number): void {
    if (layer.params.kind !== "Text") return;
    const tInLayerUs = tUs - layer.t_start_us;
    // Two overrides, one map: the transform channels compose additively with the
    // tracks, while the layout box replaces them outright because it has no track
    // to compose with (ADR 0049). Both are read here so an in-flight gizmo
    // gesture lands every field it touches on the same frame.
    text.sprite.update(
      withTextBoxOverride(
        layer.id,
        withTransformOverride(layer.id, resolveTextView(layer.params, tInLayerUs)),
      ),
    );
    text.sprite.text.zIndex = z;
  }

  // ============================================================
  // Motif
  // ============================================================

  private ensureMotif(layer: LayerSummary): ActiveMotif | null {
    if (layer.params.kind !== "Motif") return null;
    const motifId = layer.params.motif_id;
    const existing = this.activeMotifs.get(layer.id);
    if (existing) {
      if (existing.motifId === motifId) return existing;
      // The layer was retargeted to a different Motif (Edit-swap / Discard /
      // Update rebind) — dispose the stale sprite so a fresh one re-fetches
      // getMotif(motifId) and re-captures. Keyed by layer.id, so the map slot
      // is replaced below.
      existing.sprite.dispose();
      existing.effects.dispose();
      this.activeMotifs.delete(layer.id);
    }
    const sprite = new MotifSprite({
      layerId: layer.id,
      motifId,
      fpsNum: this.host.fpsNum(),
      fpsDen: this.host.fpsDen(),
      onLoaded: () => this.host.scheduleRepaint(),
    });
    const tmpl: ActiveMotif = { layerId: layer.id, motifId, sprite, effects: new EffectChain() };
    this.activeMotifs.set(layer.id, tmpl);
    // eslint-disable-next-line no-console
    console.log(
      `[weftcut/pixi] motif ${layer.id} → ${motifId} attached`,
    );
    return tmpl;
  }

  private updateMotif(
    tmpl: ActiveMotif,
    layer: LayerSummary,
    z: number,
    tUs: number,
  ): void {
    if (layer.params.kind !== "Motif") return;
    // Layer-relative time, mirroring `updateImage`. Motifs have no
    // source-in offset, so this resets to 0 at `t_start` — the intended
    // semantic (a motif animates over its own placed duration).
    const tInLayerUs = tUs - layer.t_start_us;
    const durationUs = layer.t_end_us - layer.t_start_us;
    // Export mode's pre-baked frames for this layer INSTANCE (exportBake.ts
    // keys them by the same ref path). Undefined in preview, or when this
    // layer wasn't baked.
    const injected = this.host.motifFrames(this.keyFor(layer.id));
    tmpl.sprite.update(
      withTransformOverride(layer.id, resolveMotifView(layer.params, tInLayerUs)),
      tInLayerUs,
      durationUs,
      injected,
    );
    tmpl.sprite.sprite.zIndex = z;
  }

  // ============================================================
  // CompositionRef (a Group layer)
  // ============================================================

  /// The child node for a Group layer, built on first sight and kept while
  /// the layer points at the same composition. Refused — nothing drawn, one
  /// warning — past `MAX_COMPOSITION_DEPTH` and for a composition the summary
  /// does not carry (validation rejects both; this is the render-side
  /// defence, the same silence as the Rust mixer).
  private ensureCompositionRef(layer: LayerSummary): ActiveRef | null {
    if (layer.params.kind !== "CompositionRef") return null;
    const compositionId = layer.params.composition_id;
    const existing = this.refs.get(layer.id);
    if (existing && existing.compositionId === compositionId) return existing;
    if (existing) {
      existing.sprite.dispose();
      existing.effects.dispose();
      this.refs.delete(layer.id);
    }
    if (this.depth + 1 > MAX_COMPOSITION_DEPTH) {
      if (!this.warnedDepth) {
        this.warnedDepth = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[weftcut/pixi] group ${layer.id} nests deeper than ${MAX_COMPOSITION_DEPTH}; not drawn`,
        );
      }
      return null;
    }
    const composition = this.summary?.compositions[compositionId];
    if (!composition) return null;
    const frame = childFrame(
      layer,
      layer.params.src_in_us,
      this.offsetUs,
      this.windowStartUs,
      this.windowEndUs,
    );
    const node = new CompositionNode({
      host: this.host,
      composition,
      summary: this.summary,
      width: composition.width,
      height: composition.height,
      path: refPath(this.path, layer.id),
      depth: this.depth + 1,
      offsetUs: frame.offsetUs,
      windowStartUs: frame.windowStartUs,
      windowEndUs: frame.windowEndUs,
    });
    const sprite = new CompositionRefSprite({
      layerId: layer.id,
      node,
      renderer: this.host.renderer,
    });
    const ref: ActiveRef = { layerId: layer.id, compositionId, sprite, effects: new EffectChain() };
    this.refs.set(layer.id, ref);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] group ${layer.id} → composition ${compositionId} attached`);
    return ref;
  }

  private updateCompositionRef(
    ref: ActiveRef,
    layer: LayerSummary,
    z: number,
    tInLayerUs: number,
    effectOpts: EffectOpts,
  ): void {
    if (layer.params.kind !== "CompositionRef") return;
    ref.sprite.update(
      withTransformOverride(layer.id, resolveCompositionRefView(layer.params, tInLayerUs)),
      tInLayerUs,
      effectOpts,
    );
    ref.sprite.sprite.zIndex = z;
  }

  // ============================================================
  // Audio
  // ============================================================

  private ensureAudio(layer: LayerSummary): ActiveAudio | null {
    if (layer.params.kind !== "Audio") return null;
    const graph = this.host.audioGraph();
    if (graph === null) return null;
    const existing = this.audios.get(layer.id);
    if (existing) return existing;
    const mediaId = layer.params.media_id;
    // The mixer Range-reads the media's conform PCM — no decode in the
    // renderer. `null` until the conform job lands: the layer stays
    // silent and we retry on a later tick (the media summary updates
    // when the job completes).
    const url = this.host.conformAssetUrl(mediaId);
    if (!url) {
      if (!this.conformWarned.has(mediaId)) {
        this.conformWarned.add(mediaId);
        // eslint-disable-next-line no-console
        console.warn(
          `[weftcut/pixi] no conform PCM yet for media ${mediaId} (layer ${layer.id}); audio silent until the conform job completes`,
        );
      }
      return null;
    }
    this.conformWarned.delete(mediaId);
    const placed = placeLayer(layer, this.offsetUs, this.windowStartUs, this.windowEndUs);
    const mixer = new AudioMixer(
      {
        layerId: this.keyFor(layer.id),
        conformUrl: url,
        view: layer.params,
        layerTStartUs: placed.tStartUs,
        layerTEndUs: placed.tEndUs,
      },
      graph,
    );
    const audio: ActiveAudio = {
      layerId: layer.id,
      mediaId,
      mixer,
      lastParamsRef: layer.params,
      lastParamsJson:
        JSON.stringify(layer.params) + `|${placed.tStartUs}|${placed.tEndUs}`,
      // Sentinel: the constructor derived the mixer at unity role gain, so
      // the first selection-loop pass must re-derive with the real role gain.
      lastRoleGain: NaN,
    };
    this.audios.set(layer.id, audio);
    // eslint-disable-next-line no-console
    console.log(`[weftcut/pixi] audio ${layer.id} → media ${mediaId} attached`);
    return audio;
  }
}
