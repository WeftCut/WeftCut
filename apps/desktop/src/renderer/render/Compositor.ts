// PixiJS-backed composition root. Owns the scene graph and the
// per-frame composite. Does NOT own the PIXI `Application` lifecycle —
// the host (`@pixi/react`'s `<Application>` for preview, or a Worker
// shell for export) is responsible for constructing and destroying
// the Application. The Compositor receives an already-initialized
// `Application` reference at construction.
//
// The Compositor draws ONE composition — the open one in preview, the root
// in export — through a `CompositionNode` staged into `stage`; that node's
// sweep recurses into Group layers through `CompositionRefSprite`s, each
// with a node of its own. What lives here is what every node shares: the
// decoder pool, the ingest shaders, underrun and presentation
// state. The motif raster lifecycle (prewarm/bake/hydrate/GC/status) lives in
// the `MotifFrameService` collaborator.
//
// Plan: docs/render.md

import { Application, Container } from "pixi.js";
import type { InjectedMotifFrames } from "./worker/motifStream";

import { snapFrameFloor } from "../frames";
import type { CompositionSummary, MediaSummary, ProjectSummary } from "../ipc";
import { compositionOrRoot, EMPTY_COMPOSITION } from "../ipc/compositions";
import { SourceDecoderPool } from "./decoder/SourceDecoderPool";
import type { DecoderPool } from "./decoder/session";
import {
  planPreviewDecodePriority,
  type PreviewDecodePriorityPlan,
} from "./decoder/previewDecodePriority";
import { MotifFrameService } from "./motifs/MotifFrameService";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { Nv12Ingest } from "./nv12/Nv12Ingest";
import { TenBitIngest } from "./tenbit/TenBitIngest";
import { loadBundledFontBytes } from "./fonts/registry";
import { loadFontsIntoFaceSet } from "./fonts/loadFontsIntoFaceSet";
import { installCjkLineBreaking } from "./fonts/lineBreak";
import type { TextFit } from "./textBox";
import { STAGE, stageAdd, stageRecord } from "./perf/stageTimers";
import {
  UnderrunTracker,
  type UnderrunSessionSummary,
  type UnderrunSnapshot,
} from "./underrunTracker";
import {
  CompositionNode,
  type ActiveClipProbe,
  type ClipPerfRow,
  type CompositionNodeHost,
  type ResolvedRendererSource,
} from "./CompositionNode";
export type { ActiveClipProbe, ResolvedRendererSource } from "./CompositionNode";

/// Match the preview ring's default lookahead window
/// (`FrameRing.DEFAULT_LOOKAHEAD_US`). We only use this to warm the next clip
/// boundary; video preparation never gates the session's audio clock.
const UPCOMING_CLIP_PREWARM_US = 1_000_000;

/// Plain-numbers diagnostic snapshot for the dev `PerfHUD`. All fields
/// are safe to ship to a React state hook every 500ms; no live decoder
/// or sprite references leak out.
export interface CompositorPerfSnapshot {
  /// Most recent `compositeFrame` body duration in ms.
  compositeMsLast: number;
  /// Running peak since the last `resetPerfPeaks()`.
  compositeMsMax: number;
  /// Last preview-only upcoming-clip prewarm attempt. Null before
  /// the first `setAnchorTime()` tick or in export mode.
  upcomingPrewarm: UpcomingClipPrewarmSnapshot | null;
  /// Number of in-flight no-flash source swaps (bridge→proxy), every node
  /// counted. Non-zero during the overlap window when a clip is being
  /// repointed to a freshly-built proxy; explains transient extra decode cost.
  swapsInFlight: number;
  /// Playback underrun state (dropped-frame indicator's ground truth).
  underrun: UnderrunSnapshot;
  /// Transition node + RT-pool accounting for the OPEN composition's node;
  /// null until its first active window. `rt.created` staying flat across a
  /// played transition is the "no per-frame RT allocation" memory-ratchet probe.
  transitions: {
    nodes: number;
    rt: { free: number; outstanding: number; created: number; destroyed: number };
  } | null;
  /// Every live clip, Groups' included.
  clips: ClipPerfRow[];
}

export interface UpcomingClipPrewarmSnapshot {
  /// Composition time that drove the prewarm decision.
  anchorUs: number;
  /// Future window scanned for the next clip boundary.
  windowUs: number;
  /// Start time of the nearest future VideoClip in the prewarm plan.
  /// Null means no upcoming VideoClip was found.
  nextStartUs: number | null;
  clips: Array<{
    layerId: string;
    mediaId: string;
    /// True if a DecodeSession existed or was created and
    /// `requestFrameAt(src_in_us)` was issued.
    requested: boolean;
    decodeQueueSize: number;
    ringSize: number;
    ringLastPtsUs: number | null;
  }>;
}

export interface CompositorInit {
  /// Pre-initialized PIXI Application. The Compositor adds its stage
  /// `Container` to `app.stage` and reads `app.renderer`.
  app: Application;
  /// Project composition dimensions in pixels.
  width: number;
  height: number;
  /// Preview can prefer interactive over throughput; export wants
  /// throughput. What it gates: see the private `mode` field.
  mode: "preview" | "export";
  /// EXPORT mode's resolver for the asset URL of a media item's master proxy
  /// (decoded via WebCodecs). Preview mode uses `resolveSource` instead and
  /// does NOT pass this. Defaults to `() => null` when absent.
  proxyAssetUrl?: (mediaId: string) => string | null;
  /// PREVIEW mode's engine resolution: gathers store inputs and runs the pure
  /// `resolveDecodeEngine`, returning the resolved decode source (engine +
  /// source + target + swap key). REQUIRED in preview mode; export mode uses
  /// `proxyAssetUrl` instead. Defaults to `() => null` so export/worker are
  /// unaffected.
  resolveSource?: (mediaId: string) => ResolvedRendererSource | null;
  /// Preview-only: called when `resolveSource` reports `status: "unsupported"`
  /// for a media — no engine can decode it (e.g. a pinned Standard engine with
  /// no usable component, or WebCodecs failing the original with no proxy
  /// underway). Drives PixiPreview's `UnsupportedClipCard`; export omits it,
  /// and an unsupported clip is skipped from the composite either way. Fires a
  /// SNAPSHOT (`ReadonlySet<string>`) of every media unsupported AT THE
  /// CURRENT COMPOSITE, and ONLY when membership changed vs. the previous
  /// composite — never per-frame, which would drive React state above a leaf
  /// (feedback_playhead_gate_and_tiers). See `compositeFrame`'s
  /// reset/diff/fire around its layer sweep.
  onUnsupported?: (unsupported: ReadonlySet<string>) => void;
  /// Preview-only: playback underrun (dropped + late-tick) state changes for
  /// the transport-bar indicator. Edge-triggered + throttled by
  /// `UnderrunTracker` (never per-frame — feedback_playhead_gate_and_tiers);
  /// safe to feed straight into React state. Export omits it.
  onUnderrun?: (snapshot: UnderrunSnapshot) => void;
  /// Resolver for the asset URL of a media item's ORIGINAL file.
  /// Used for ImageOverlay layers (loaded via `createImageBitmap`).
  /// May return the same URL as `proxyAssetUrl` for media kinds
  /// that don't get proxied (images, audio).
  originalAssetUrl: (mediaId: string) => string | null;
  /// Resolver for a media item's ffprobe-derived source color tags
  /// (matrix/range/primaries/transfer), mapped to WebCodecs. Applied to every
  /// decode target for the media — the original trivially, and proxies too
  /// (a proxy preserves the source's colorimetry; its own container tag still
  /// outranks this per-field in `withDefaultColorSpace`) — so 601/full-range
  /// sources render with their real color from either URL. Returns undefined
  /// when nothing maps.
  sourceColor: (mediaId: string) => VideoColorSpaceInit | undefined;
  /// Lookup for media-side codec dimensions.
  mediaById: (mediaId: string) => MediaSummary | undefined;
  /// Optional decoder pool override. Defaults to a preview-tuned
  /// `SourceDecoderPool` with per-frame lookahead + ring eviction. The
  /// export Worker injects an `ExportDecoderPool` that drives decoding
  /// in batched chunks instead.
  pool?: DecoderPool;
}

export class Compositor {
  readonly app: Application;
  readonly stage: Container;
  readonly pool: DecoderPool;
  /// The node that draws the open composition, staged into `stage`. Rebuilt —
  /// every sprite and session torn down — when the open composition changes;
  /// a new snapshot of the same composition only reconciles it.
  private root: CompositionNode;
  /// What every node reads of this Compositor (CompositionNode.ts).
  private readonly host: CompositionNodeHost;
  /// On-screen media reported `status: "unsupported"` by `resolveSource`
  /// AT THE CURRENT COMPOSITE. Ownership split: `compositeFrame` resets the
  /// set at the start of its layer sweep and fires `onUnsupported` on
  /// membership change at the end; the nodes' `ensureClip` unsupported branch
  /// only ADDS. A clip the playhead scrolled off of (or a disabled layer) is
  /// never visited by the sweep, so it drops out instead of lingering.
  private unsupportedMedia = new Set<string>();
  /// Export-only borrowed pixels, keyed by Group instance path. See
  /// `setMotifFrames`; empty in preview mode.
  private motifFrames = new Map<string, InjectedMotifFrames>();
  /// Preview or export. Gates audio setup, decode-source resolution
  /// (`resolveSource` vs `proxyAssetUrl`), and the upcoming-clip prewarm.
  private mode: "preview" | "export";
  private projectSummary: ProjectSummary | null = null;
  private proxyAssetUrl: (mediaId: string) => string | null;
  private resolveSource: (mediaId: string) => ResolvedRendererSource | null;
  /// Preview-only unsupported-format notification (see `CompositorInit`).
  /// Undefined when the host doesn't wire it (export never does).
  private onUnsupported: ((unsupported: ReadonlySet<string>) => void) | undefined;
  private originalAssetUrl: (mediaId: string) => string | null;
  private sourceColor: (mediaId: string) => VideoColorSpaceInit | undefined;
  private mediaById: (mediaId: string) => MediaSummary | undefined;
  private compositionWidth = 1920;
  private compositionHeight = 1080;
  private disposed = false;
  /// Lazily created on the first TenBitFrame — the 10-bit export lane AND the
  /// 10-bit VideoToolbox preview lane both ring these. Backend posture: see
  /// ensureTenBitIngest.
  private tenBitIngest: TenBitIngest | null = null;
  /// Lazily created on the first NativeNv12Frame — the 8-bit native export
  /// lane AND the native SW preview lane both ring these (CPU planes convert
  /// in our shader, never the browser's — nv12Frame.ts / ADR 0032). Backend
  /// posture: see ensureNv12Ingest.
  private nv12Ingest: Nv12Ingest | null = null;
  /// Most recent composition time we composited at. Used by
  /// `scheduleRepaint()` for async-arrived frames when the playhead
  /// is paused (no rAF tick incoming).
  private lastTUs = 0;
  /// The preview realm's motif raster lifecycle (L0 warm, L2 bake,
  /// baked-index hydrate/GC, bake status) — owned here as a collaborator;
  /// see motifs/MotifFrameService.ts. Inert in the export Worker (no DOM).
  private readonly motifService: MotifFrameService;
  private repaintScheduled = false;
  /// Engine's playing state — written by PlaybackEngine on play /
  /// pause / seek. Decoder targeting reads this presentation state.
  private playing = false;
  /// When true, `setAnchorTime` is a no-op. PlaybackEngine flips this
  /// during rapid scrub so the decoder isn't hammered with a new
  /// target on every mouse-move event; the rAF loop keeps painting
  /// whatever frame is already in the ring (approximate but immediate
  /// visual feedback). Cleared after the scrub coalescer fires its
  /// stable-target callback, at which point the decoder catches up.
  private scrubbing = false;
  /// While true, `compositeFrame` and `setAnchorTime` are no-ops (see
  /// `setSuspended`).
  private suspended = false;
  /// Dock-tab presentation state. Hidden Preview retains every owned resource
  /// but skips decoder targeting and visual
  /// scene mutation until the Panel becomes visible again.
  private presentationVisible = true;
  private presentationDirty = false;
  private ownerCompositeCount = 0;
  private presentedCompositeCount = 0;
  /// Raw fps rational so `setAnchorTime` / `compositeFrame` can snap `tUs`
  /// to project-frame boundaries with exact rational arithmetic. Always
  /// `snapFrameFloor(tUs, this.fpsNum, this.fpsDen)`, never a pre-rounded
  /// `Math.floor(tUs / frameDur) * frameDur` — the rounded duration drifts
  /// ~1 µs/frame until a lookup lands in the previous frame's source-PTS
  /// interval and paints the wrong frame (arithmetic: frames.ts).
  private fpsNum = 30;
  private fpsDen = 1;
  /// Diagnostic counters for the dev `PerfHUD` (see `CompositorPerfSnapshot`),
  /// written by `compositeFrame` itself.
  private compositeMsLast = 0;
  private compositeMsMax = 0;
  private upcomingPrewarm: UpcomingClipPrewarmSnapshot | null = null;
  /// One priority plan per project snapshot + snapped composition time. A
  /// normal playback tick reaches this through setAnchor, boundary prewarm and
  /// composite; caching keeps that at one O(layers) scan and one pool publish.
  private decodePriorityPlanCache: {
    summary: ProjectSummary;
    tUs: number;
    plan: PreviewDecodePriorityPlan;
  } | null = null;
  /// Underrun accounting — dropped frames and late composite ticks
  /// (preview only; inert in export mode where `playing` never goes true).
  /// Sweep verdicts come from the nodes' `updateClip` via `sweepLateLayers`;
  /// session lifecycle from `setMasterPlayState`; the tick interval is read
  /// off the tracker's own clock.
  private underrun: UnderrunTracker;
  /// Visible VideoClip layers judged late during the CURRENT composite
  /// sweep. Reset before the layer loop, read after it — same
  /// reset/accumulate/fire ownership split as `unsupportedMedia`.
  private sweepLateLayers = 0;

  constructor(init: CompositorInit) {
    this.app = init.app;
    this.stage = new Container();
    this.pool = init.pool ?? new SourceDecoderPool();
    // Default null-resolvers: preview passes `resolveSource`, export passes
    // `proxyAssetUrl`; each mode's ensureClip branch reads only its own.
    this.proxyAssetUrl = init.proxyAssetUrl ?? ((): string | null => null);
    this.resolveSource = init.resolveSource ?? ((): ResolvedRendererSource | null => null);
    this.onUnsupported = init.onUnsupported;
    this.originalAssetUrl = init.originalAssetUrl;
    this.sourceColor = init.sourceColor;
    this.mediaById = init.mediaById;
    this.compositionWidth = init.width;
    this.compositionHeight = init.height;
    this.mode = init.mode;
    this.underrun = new UnderrunTracker({ onChange: init.onUnderrun });
    this.app.stage.addChild(this.stage);
    this.host = {
      renderer: this.app.renderer,
      pool: this.pool,
      mode: this.mode,
      fpsNum: () => this.fpsNum,
      fpsDen: () => this.fpsDen,
      playing: () => this.playing,
      scrubbing: () => this.scrubbing,
      resolveSource: (id) => this.resolveSource(id),
      proxyAssetUrl: (id) => this.proxyAssetUrl(id),
      originalAssetUrl: (id) => this.originalAssetUrl(id),
      sourceColor: (id) => this.sourceColor(id),
      mediaById: (id) => this.mediaById(id),
      motifFrames: (key) => this.motifFrames.get(key),
      ensureTenBitIngest: () => this.ensureTenBitIngest(),
      ensureNv12Ingest: () => this.ensureNv12Ingest(),
      releaseIngest: (key) => {
        this.tenBitIngest?.release(key);
        this.nv12Ingest?.release(key);
      },
      scheduleRepaint: () => this.scheduleRepaint(),
      noteUnsupported: (mediaId) => {
        this.unsupportedMedia.add(mediaId);
      },
      noteLateLayer: () => {
        this.sweepLateLayers += 1;
      },
    };
    this.root = this.buildRoot(EMPTY_COMPOSITION, null);
    this.motifService = new MotifFrameService({
      projectSummary: () => this.projectSummary,
      openCompositionId: () => this.root.composition.id,
      fpsNum: () => this.fpsNum,
      fpsDen: () => this.fpsDen,
      currentTimeUs: () => this.lastTUs,
    });
    // THE install site for the CJK break rule, and the reason one site is
    // enough: `canBreakWords` is a class static, so it must be set in every
    // realm that rasterizes text — and every such realm builds a Compositor
    // (the export Worker included). Installing here is realm-complete by
    // construction, where a per-realm call list has to be remembered.
    //
    // LANDMINE: it MUST stay outside the preview branch below. The hook needs
    // neither `document` nor a FontFaceSet, and gating it on those conditions
    // is exactly the defect this guards — preview would wrap CJK and the
    // burned-in export would not, which nobody sees until they export.
    // `e2e/electron/text-box-cjk-export.spec.ts` is what goes red for it.
    installCjkLineBreaking();
    // Preview + real DOM only — the export Worker has neither `document`
    // nor preview audio.
    if (this.mode === "preview" && typeof document !== "undefined") {
      // Bundled fonts: same set as the export Worker, so preview matches the
      // burned-in output. Awaited off the constructor; the first post-load
      // redraw picks them up.
      void loadBundledFontBytes().then((b) =>
        loadFontsIntoFaceSet(document.fonts, b),
      );
    }
  }

  /// The open composition's node, lent to it: `stage` is its container. Root
  /// in root time — offset 0, no window — whatever composition is open, so an
  /// opened Group plays on its own clock.
  private buildRoot(composition: CompositionSummary, summary: ProjectSummary | null): CompositionNode {
    return new CompositionNode({
      host: this.host,
      composition,
      summary,
      width: this.compositionWidth,
      height: this.compositionHeight,
      path: "",
      depth: 0,
      offsetUs: 0,
      windowStartUs: Number.NEGATIVE_INFINITY,
      windowEndUs: Number.POSITIVE_INFINITY,
      container: this.stage,
    });
  }

  /// The node drawing the open composition — for tests and diagnostics.
  rootNode(): CompositionNode {
    return this.root;
  }

  /// Coalesced repaint at the current playhead time. Called by
  /// SourceHandle.onFirstFrame so the canvas updates as soon as a
  /// decoded frame is available, even when the playback engine isn't
  /// actively ticking (paused state).
  scheduleRepaint(): void {
    if (this.disposed) return;
    if (!this.presentationVisible) {
      this.presentationDirty = true;
      return;
    }
    if (this.repaintScheduled) return;
    this.repaintScheduled = true;
    requestAnimationFrame(() => {
      this.repaintScheduled = false;
      if (this.disposed) return;
      this.setAnchorTime(this.lastTUs);
      this.compositeFrame(this.lastTUs);
    });
  }

  /// Preview-only: hand the decoder pool a new playback-resolution divisor
  /// (1 | 2 | 4). Pure passthrough — the pool owns both the value and the
  /// in-place transport re-open. Optional-chained because the export pool has
  /// no such method (export always decodes full size).
  setPlaybackScaleDiv(div: number): void {
    this.pool.setPlaybackScaleDiv?.(div);
  }

  /// Adopt a new composition size mid-session — the open composition's. Child
  /// nodes are sized by their own compositions and are not touched. What the
  /// size drives and why it has to be told: `CompositionNode.setSize`.
  setCompositionSize(width: number, height: number): void {
    if (width === this.compositionWidth && height === this.compositionHeight) return;
    this.compositionWidth = width;
    this.compositionHeight = height;
    this.root.setSize(width, height);
    this.scheduleRepaint();
  }

  setPresentationVisible(visible: boolean): void {
    if (this.presentationVisible === visible) return;
    this.presentationVisible = visible;
    if (visible) {
      this.scheduleRepaint();
    } else {
      this.presentationDirty = true;
    }
  }

  /** Stable read-only lifecycle probe for integration tests and diagnostics. */
  presentationSnapshot(): {
    visible: boolean;
    dirty: boolean;
    ownerCompositeCount: number;
    presentedCompositeCount: number;
  } {
    return {
      visible: this.presentationVisible,
      dirty: this.presentationDirty,
      ownerCompositeCount: this.ownerCompositeCount,
      presentedCompositeCount: this.presentedCompositeCount,
    };
  }

  /// PlaybackEngine flips this during rapid scrub; rationale on the
  /// `scrubbing` field.
  setScrubbing(s: boolean): void {
    this.scrubbing = s;
  }

  /// PlaybackEngine writes its current play state here on play /
  /// pause / seek so decoder targeting knows whether to advance.
  setMasterPlayState(playing: boolean): void {
    // Master-clock release = new play session: reset the dropped-frame
    // counters so the indicator reflects this run, not history.
    if (playing && !this.playing) this.underrun.beginPlay();
    this.playing = playing;
  }

  /// PlaybackEngine calls this on an in-play seek. The seek flushes the
  /// decoder rings, so the tracker suppresses lateness until the
  /// pipeline re-primes (first all-fresh sweep, capped) — otherwise
  /// every timeline click during playback would flash the indicator.
  noteSeekWhilePlaying(): void {
    this.underrun.noteSeekWhilePlaying();
  }

  /// Session-end dropped + late counts for the LogBus summary row; at most
  /// once per play session (see `UnderrunTracker.takeSessionSummary`).
  takeUnderrunSessionSummary(): UnderrunSessionSummary {
    return this.underrun.takeSessionSummary();
  }

  /// Export-only borrowed pixels for the current output frame, keyed by Group
  /// instance path. The worker releases these bitmaps after rendering.
  setMotifFrames(map: Record<string, InjectedMotifFrames>): void {
    this.motifFrames.clear();
    for (const [key, frames] of Object.entries(map)) {
      this.motifFrames.set(key, frames);
    }
  }

  /// Suspend / resume the compositor. While suspended, every
  /// VideoClip's decoder is closed (releasing its hardware decode
  /// slot), and `compositeFrame` /
  /// `setAnchorTime` are short-circuited so the engine's rAF loop
  /// can't lazily re-create decoders. The next `compositeFrame` after
  /// `setSuspended(false)` re-acquires fresh handles via the normal
  /// `ensureClip` path.
  ///
  /// Used by export: the export Worker's decoder otherwise wedges
  /// when the preview's decoder is still holding a hardware video-
  /// decode slot for the same source.
  setSuspended(s: boolean): void {
    if (this.suspended === s) return;
    this.suspended = s;
    if (s) {
      this.root.suspend();
      this.tenBitIngest?.dispose();
      this.tenBitIngest = null;
      this.nv12Ingest?.dispose();
      this.nv12Ingest = null;
      this.pool.dispose();
    }
  }

  /// Replace the project snapshot and name the composition to draw: `openId`
  /// (the preview's render target — compositionAnchorStore.ts), the root
  /// when omitted or unknown. Export always omits it: a Group is a source, and
  /// a file of one alone is a file nobody asked for. A change of composition
  /// rebuilds the node — every sprite, mixer and decode session goes, since
  /// none of them belongs to the new timeline; a new snapshot of the same
  /// composition only evicts the layers that disappeared.
  setProject(summary: ProjectSummary | null, openId: string | null = null): void {
    this.decodePriorityPlanCache = null;
    const prevProjectId = this.projectSummary?.project_id ?? null;
    this.projectSummary = summary;
    const composition = compositionOrRoot(summary, openId) ?? EMPTY_COMPOSITION;
    const sameNode =
      composition.id === this.root.composition.id &&
      (summary?.project_id ?? null) === prevProjectId;
    if (!sameNode) {
      this.root.dispose();
      this.root = this.buildRoot(composition, summary);
    } else {
      this.root.setComposition(composition, summary);
    }
    if (!summary) {
      // No `unsupportedMedia` bookkeeping: `compositeFrame` short-circuits
      // while the summary is null, and its next real sweep resets the set.
      this.tenBitIngest?.dispose();
      this.tenBitIngest = null;
      this.nv12Ingest?.dispose();
      this.nv12Ingest = null;
      // The service's null-summary path tears the motif lifecycle down.
      this.motifService.handleProjectChanged();
      return;
    }
    // Recompute the frame-snap fps state whenever the project changes
    // (composition fps could differ between projects).
    if (composition.fps_num > 0 && composition.fps_den > 0) {
      this.fpsNum = composition.fps_num;
      this.fpsDen = composition.fps_den;
      // Same fps drives the underrun tracker's late-tick threshold.
      this.underrun.bindFrameBudgetMs((1_000 * this.fpsDen) / this.fpsNum);
    }
    // No `unsupportedMedia` reconciliation: the next `compositeFrame` sweep
    // rebuilds the set from this project's layers and fires on any change.
    // The motif lifecycle (prewarm/bake re-plan at the current playhead, bake
    // statuses, baked-index hydrate/GC) lives in the service — one hook per
    // project change. Called AFTER the fps update above so its planning reads
    // the new frame grid.
    this.motifService.handleProjectChanged();
  }

  /// Composite one frame at composition-time `tUs`.
  ///
  /// We do NOT call `app.renderer.render()` here. PixiJS v8's
  /// `TickerPlugin` auto-renders the stage every frame (default
  /// `autoStart: true`), and @pixi/react's Application reconciler is
  /// wired against that ticker. compositeFrame's job is to mutate
  /// the scene graph; the ticker presents it.
  compositeFrame(tUs: number, effectInput?: import('./effects/EffectInputCapture').EffectInputRequest): void {
    if (this.disposed) return;
    if (this.suspended) return;
    this.lastTUs = tUs;
    if (!this.projectSummary) return;
    const compositeStart = performance.now();

    // Snap wall-clock tUs to the project's frame grid. Without this, rAF
    // jitter (real ticks at 14–19 ms, not a clean 16.67) lands high-fps
    // source frames in two different rAF windows — one source frame shows
    // twice while its neighbor is skipped. Snapping keeps frame selection
    // consistent across ticks at the cost of rendering at the project's
    // authored fps rather than the display rate (matching export).
    // Exact-rational snap only — pre-rounded frame durations drift (see
    // `fpsNum`).
    const tUsSnapped = snapFrameFloor(tUs, this.fpsNum, this.fpsDen);
    // Declare active + planned-upcoming ownership before `ensureClip` opens
    // any source in the visual sweep. If main rejects an upcoming HW open, the
    // pool may now reclaim only truly retained sessions, never a clip this
    // frame is still presenting (including either overlap-swap key).
    this.updateDecodePriorities(tUsSnapped);

    const prevChildCount = this.stage.children.length;

    this.ownerCompositeCount += 1;
    // Hidden dock tabs retain decoder ownership but skip presentation.
    // Audio is independently scheduled by the editor session.
    if (!this.presentationVisible) {
      this.presentationDirty = true;
      // The tick clock must be stamped on THIS exit too: composites keep
      // running every frame while the tab is hidden, and a frozen
      // `lastTickMs` turns the whole hidden interval into one giant "late
      // tick" the moment the tab is shown again — a false lateFrame, a lit
      // indicator, and a warn row blaming a render loop that never stalled.
      // Same contract as the scrub/pause path in the visible tail.
      if (this.mode === "preview") this.underrun.tickDecay();
      // The `compositeMsLast` stamp at the tail never sees this exit, so this
      // bracket is the only account of an audio-only (hidden-tab) frame.
      stageAdd(STAGE.Composite, compositeStart);
      return;
    }
    this.presentationDirty = false;
    this.presentedCompositeCount += 1;

    // Export ignores the preview-only LOD toggle — effects are always
    // applied at full quality during export regardless of the user's
    // preview performance setting. The export worker realm never
    // hydrates the settings store, but this guard is structural so
    // correctness doesn't depend on that implementation detail.
    const previewEffectsEnabled =
      this.mode === "export" || effectInput
        ? true
        : useAppSettingsStore.getState().settings.preview_effects_enabled;

    // Fresh per-composite unsupported-media set — the reset half of the
    // ownership split documented on `unsupportedMedia`; the nodes only ADD
    // during the sweep below.
    const prevUnsupported = this.unsupportedMedia;
    this.unsupportedMedia = new Set<string>();
    // Same reset half for the underrun sweep; `updateClip` only ADDS.
    this.sweepLateLayers = 0;

    this.root.compositeVisual(tUsSnapped, effectInput ? { previewEffectsEnabled, effectInput } : { previewEffectsEnabled });

    // Fire `onUnsupported` ONLY on membership change — size first (cheap),
    // then an early-exit membership scan. An unconditional fire would drive
    // React `setState` per frame — the whole-tree re-render memory ratchet
    // (feedback_playhead_gate_and_tiers).
    let unsupportedChanged = this.unsupportedMedia.size !== prevUnsupported.size;
    if (!unsupportedChanged) {
      for (const id of this.unsupportedMedia) {
        if (!prevUnsupported.has(id)) {
          unsupportedChanged = true;
          break;
        }
      }
    }
    if (unsupportedChanged) {
      this.onUnsupported?.(new Set(this.unsupportedMedia));
    }
    // Underrun verdict for this sweep. Judged only while the master
    // clock is running and not scrubbing (a scrub deliberately paints
    // approximate frames); decay ticks unconditionally so the indicator
    // dims after pause too (the engine's rAF tick keeps compositing).
    //
    // `tickDecay` must stay on the unconditional path: it also stamps the
    // tracker's tick clock, and moving it under the `playing && !scrubbing`
    // guard would make a whole scrub or pause difference into one giant
    // late tick when judging resumes.
    if (this.mode === "preview") {
      if (this.playing && !this.scrubbing) {
        this.underrun.judgeSweep(this.sweepLateLayers > 0, tUsSnapped);
      }
      this.underrun.tickDecay();
    }
    // One-shot diagnostic the first time we transition from "stage
    // has no children" to "stage has some" so the user can confirm
    // sprites are reaching the scene graph.
    if (prevChildCount === 0 && this.stage.children.length > 0) {
      const s = this.stage.children[0] as unknown as {
        x: number;
        y: number;
        scale: { x: number; y: number };
        alpha: number;
        // Optional: a Color layer's first sprite is a Graphics-backed fill
        // with no `texture.orig`. Reading it unguarded crashed the composite
        // path for any color-first composition (export AND preview).
        texture?: { orig?: { width: number; height: number } };
        visible: boolean;
      };
      // eslint-disable-next-line no-console
      console.log(
        `[weftcut/pixi] first sprite added to stage: ` +
          `pos=(${s.x},${s.y}) scale=(${s.scale.x},${s.scale.y}) ` +
          `alpha=${s.alpha} visible=${s.visible} ` +
          `tex=${s.texture?.orig?.width ?? "?"}×${s.texture?.orig?.height ?? "?"} ` +
          `compStage.children=${this.stage.children.length} ` +
          `appStage.children=${this.app.stage.children.length}`,
      );
    }
    // Refresh the motif prewarm/bake windows when the playhead crosses a frame
    // boundary. Throttled to once per composition frame inside the service, so
    // scrub/play ticks within the same frame don't re-plan. Runs whether
    // playing or paused; a no-op in the DOM-less export realm.
    this.motifService.noteFrameBoundary(tUsSnapped);
    // Stamp the duration last — anything that early-returns above
    // (disposed, suspended, no project) is correctly excluded from
    // the average, since the body did no real work.
    this.compositeMsLast = performance.now() - compositeStart;
    if (this.compositeMsLast > this.compositeMsMax) {
      this.compositeMsMax = this.compositeMsLast;
    }
    stageRecord(STAGE.Composite, this.compositeMsLast);
  }

  /// Authored duration of the composition being drawn, in microseconds.
  /// Returns 0 when no project is loaded.
  compositionDurationUs(): number {
    return this.root.durationUs();
  }

  /// Tell the decoder pool which time we're at so it can manage
  /// lookahead. Called by PlaybackEngine on every tick.
  ///
  /// Suppressed while `scrubbing` is true — fast scrub events would
  /// otherwise issue a new decoder target every mouse-move, forcing
  /// the decoder to constantly re-prioritize and never produce a
  /// stable frame at any one position. The ScrubCoalescer in
  /// PlaybackEngine clears `scrubbing` after the debounce expires
  /// and calls setAnchorTime once with the final target.
  setAnchorTime(tUs: number): void {
    if (!this.projectSummary) return;
    if (this.scrubbing) return;
    if (this.suspended) return;
    if (!this.presentationVisible) return;
    // Use the same exact-rational snap as `compositeFrame` so the
    // decoder's anchor matches the frame we're actually painting.
    // See `snapFrameFloor` and the long comment in `compositeFrame`
    // for why the pre-rounded `approxFrameDurUs` is not safe here.
    const tUsSnapped = snapFrameFloor(tUs, this.fpsNum, this.fpsDen);
    this.updateDecodePriorities(tUsSnapped);
    if (this.mode === "preview") {
      this.preparePreviewDecode(tUsSnapped);
    } else this.root.anchor(tUsSnapped);
  }

  /// Plain-number perf snapshot for the dev `PerfHUD`. Read whenever
  /// (cheap — no allocation on the hot path; numbers come from fields
  /// already updated by `compositeFrame`). Per-clip stats are filtered
  /// to active (non-disposed) handles only, so a recently-swept entry
  /// doesn't appear with bogus zeros.
  getPerfSnapshot(): CompositorPerfSnapshot {
    const clips: ClipPerfRow[] = [];
    this.root.clipPerfRows(clips);
    return {
      compositeMsLast: this.compositeMsLast,
      compositeMsMax: this.compositeMsMax,
      upcomingPrewarm: this.upcomingPrewarm,
      swapsInFlight: this.root.swapsInFlight(),
      underrun: this.underrun.snapshot(),
      transitions: this.root.transitionStats(),
      clips,
    };
  }

  /// Reset the running peak for `compositeMsMax`. Called by the HUD's
  /// "reset peaks" button so a momentary stall doesn't pin the max
  /// forever.
  resetPerfPeaks(): void {
    this.compositeMsMax = 0;
  }

  /// The untransformed content size of a live layer of the OPEN composition,
  /// in composition pixels — what the on-canvas gizmo builds its box from.
  /// Null when the layer has no staged sprite yet (off-playhead, or still
  /// decoding its first frame). Read-only. Per-kind rules:
  /// `CompositionNode.naturalSizeOf`.
  naturalSizeOf(layerId: string): { w: number; h: number } | null {
    return this.root.naturalSizeOf(layerId);
  }

  /// What the staged Text sprite did with its font size (`GizmoProbe.textFitOf`).
  /// Null for every other kind and for a Text layer not currently staged.
  textFitOf(layerId: string): TextFit | null {
    return this.root.textFitOf(layerId);
  }

  /// E2E-only (preview-sw conformance): snapshot the decode source + bound
  /// sprite of the active VideoClip named by `layerId` (or the first live
  /// clip when omitted), Groups' clips included. Returns null when no
  /// matching clip is active. Read-only — never mutates compositor state.
  activeClipProbe(layerId?: string): ActiveClipProbe | null {
    return this.root.activeClipProbe(layerId);
  }

  /// Release every sprite + decoder + the stage container. Does NOT
  /// touch the Application — the host owns its lifecycle.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // No final `onUnsupported` fire: the host's listener dies with this
    // Compositor and `compositeFrame` is now a no-op.
    this.unsupportedMedia.clear();
    this.root.dispose();
    this.motifService.dispose();
    // Drop the injected export-bake frame references. Bitmaps here are OWNED by
    // the export worker, not the Compositor — same as
    // `setMotifFrames`, which clears without closing — so we clear (no
    // `.close()`) to avoid double-freeing the caller's bitmaps.
    this.motifFrames.clear();
    this.tenBitIngest?.dispose();
    this.tenBitIngest = null;
    this.nv12Ingest?.dispose();
    this.nv12Ingest = null;
    this.pool.dispose();
    try {
      this.app.stage.removeChild(this.stage);
      this.stage.destroy({ children: true });
    } catch {
      // App may already be destroyed by the host; ignore.
    }
  }

  /// Pre-trigger image loading for every ImageOverlay layer in the drawn
  /// composition, Groups' included, and resolve once ALL are loaded. Called by
  /// the export Worker before the frame loop (`CompositionNode.preloadImages`).
  async preloadImages(): Promise<void> {
    if (!this.projectSummary) return;
    await this.root.preloadImages();
  }

  /// Refresh every live Motif sprite against the current runtime catalog and
  /// schedule a repaint. Called when `motifs:changed` fires (a draft edit /
  /// install / delete) so an edited draft's preview re-captures. Cheap +
  /// user-paced; no sprite is recreated (refreshMotif keeps the last bitmap
  /// until the fresh capture lands).
  refreshMotifs(): void {
    this.root.refreshMotifs();
    this.scheduleRepaint();
  }

  // ============================================================
  // private
  // ============================================================

  /// Lazily construct the 10-bit ingest. Backend-agnostic (GLSL + WGSL): the
  /// 10-bit export worker forces WebGL (rgba16float compositing), but the
  /// 10-bit VideoToolbox PREVIEW lane rings TenBitFrames on the
  /// WebGPU-preferring preview renderer too — same posture as ensureNv12Ingest.
  private ensureTenBitIngest(): TenBitIngest {
    if (!this.tenBitIngest) {
      this.tenBitIngest = new TenBitIngest(this.app.renderer);
    }
    return this.tenBitIngest;
  }

  /// Lazily construct the NV12 ingest. Backend-agnostic (GLSL + WGSL): the
  /// export worker forces WebGL when native decode is routed, but the native
  /// SW PREVIEW lane rings NativeNv12Frames on the WebGPU-preferring preview
  /// renderer too.
  private ensureNv12Ingest(): Nv12Ingest {
    if (!this.nv12Ingest) {
      this.nv12Ingest = new Nv12Ingest(this.app.renderer);
    }
    return this.nv12Ingest;
  }

  /// Drive active and upcoming decode from one protected demand plan. Active
  /// clips get their current target; future clips get their visible source
  /// start so they can parse, configure and fill before the cut.
  /// The shared placement walk includes trimmed Group instances, so inner
  /// cuts warm before their parent reaches them too.
  private preparePreviewDecode(tUs: number): void {
    if (!this.projectSummary) return;
    // Re-plan here as well as in the owner paths above: this method is the
    // exact point that calls `ensureClip` for speculative sources, so its
    // priority declaration must happen before that acquire even if a future
    // caller invokes prewarm from a different tick path.
    const plan = this.updateDecodePriorities(tUs)
      ?? planPreviewDecodePriority(
        this.root.composition,
        tUs,
        UPCOMING_CLIP_PREWARM_US,
        this.projectSummary,
      );
    // Acquire active instances before speculative ones, using the very same
    // demand plan that protected their leases. No first-visit tick delay.
    for (const target of plan.activeTargets) {
      const source = this.root.prewarmClip(target.layer, target.path);
      if (source) void source.requestFrameAt(target.sourceUs);
    }
    const candidates = plan.upcomingTargets;

    const clips: UpcomingClipPrewarmSnapshot["clips"] = [];
    for (const target of candidates) {
      const layer = target.layer;
      // `candidates` is pre-filtered to VideoClip layers above, but the
      // narrowing is lost through the `LayerSummary[]` array type — re-narrow
      // so `layer.params` exposes the VideoClip fields (media_id, src_in_us).
      if (layer.params.kind !== "VideoClip") continue;
      const source = this.root.prewarmClip(layer, target.path);
      if (!source) {
        clips.push({
          layerId: target.key,
          mediaId: layer.params.media_id,
          requested: false,
          decodeQueueSize: 0,
          ringSize: 0,
          ringLastPtsUs: null,
        });
        continue;
      }
      const srcTUs = target.sourceUs;
      void source.requestFrameAt(srcTUs);
      clips.push({
        layerId: target.key,
        mediaId: layer.params.media_id,
        requested: true,
        decodeQueueSize: source.decodeQueueSize?.() ?? 0,
        ringSize: source.ring.size(),
        ringLastPtsUs: source.ring.lastPtsUs(),
      });
    }
    this.upcomingPrewarm = {
      anchorUs: tUs,
      windowUs: UPCOMING_CLIP_PREWARM_US,
      nextStartUs: plan.nextStartUs,
      clips,
    };
  }

  /// Publish decode ownership without exposing Standard-engine lane policy to
  /// the Compositor. A true result means the pool upgraded a budget spill in
  /// place after ordered main-process closes; repaint with its retained ring.
  private updateDecodePriorities(tUs: number): PreviewDecodePriorityPlan | null {
    if (this.mode !== "preview" || !this.projectSummary) return null;
    const cached = this.decodePriorityPlanCache;
    if (cached && cached.summary === this.projectSummary && cached.tUs === tUs) {
      return cached.plan;
    }
    const plan = planPreviewDecodePriority(
      this.root.composition,
      tUs,
      UPCOMING_CLIP_PREWARM_US,
      this.projectSummary,
    );
    this.decodePriorityPlanCache = {
      summary: this.projectSummary,
      tUs,
      plan,
    };
    const result = this.pool.setPriorityKeys?.(plan.poolKeys);
    if (typeof result === "boolean") {
      if (result) this.scheduleRepaint();
    } else if (result) {
      void result
        .then((recycled) => {
          if (recycled && !this.disposed) this.scheduleRepaint();
        })
        .catch((err: unknown) => {
          // Ordered close failed. Keep the current spill alive rather than
          // racing a replacement open against an unreleased lease.
          // eslint-disable-next-line no-console
          console.warn("[weftcut/pixi] decode priority rebalance failed", err);
        });
    }
    return plan;
  }
}
