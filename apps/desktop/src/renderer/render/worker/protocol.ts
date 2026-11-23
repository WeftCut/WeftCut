// postMessage protocol between the main thread and the export Worker.
//
// See docs/render.md — "Export Worker".
//
// The Worker is constructed once per export, receives one `start` request,
// streams `progress` events (and `chunk` slices on the WebCodecs path; a
// native sink's frames leave on its own port), posts a final `done` with counters
// or `error`, then terminates. The main-thread shell `terminate()`s the
// worker after `done` to release its heap.

import type { ExportTransportFormat } from "../exportDecodeRouting";
import type { SourceColor } from "../decoder/ffprobeColorSpace";
import type { MotifFramePacket } from "./motifStream";
import type { SinkPixFmt } from "../../../shared/export-resources";
import type { ExportDecodeOpenInfo, PlaneColor } from "../../../shared/frameCarrier/wire";
import type { FaceRef, FontIndex } from "../../../shared/fonts/types";

/// Snapshot of project state needed to render the export. The Worker
/// receives this as a structured-clone of the live `ProjectSummary`,
/// so live edits to the project after `start` do NOT affect the
/// in-flight export.
export interface ExportProjectSnapshot {
  /// Composition dimensions. Echoed back in the encoder config.
  width: number;
  height: number;
  /// Project fps (numerator / denominator). Determines the frame
  /// grid the export iterates and the encoder's framerate.
  fpsNum: number;
  fpsDen: number;
  /// Total composition duration in microseconds; the Worker may
  /// clamp `endUs` against this.
  durationUs: number;
  /// Same shape `Compositor.setProject(summary)` consumes —
  /// `tracks: [{ enabled, layers: [{ id, t_start_us, t_end_us,
  /// enabled, params: { kind, ... } }] }]`. Worker treats this as
  /// opaque and forwards to its own Compositor instance.
  summary: unknown;
  /// `media_id → asset URL` resolved on the main thread before the
  /// Worker request is posted. The Worker can't call the renderer's
  /// `convertFileSrc()` (no renderer bridge inside the Worker), so
  /// the main thread pre-resolves every URL the renderer might
  /// need.
  proxyAssetUrls: Record<string, string>;
  originalAssetUrls: Record<string, string>;
  /// `media_id → MediaSummary` slim copy. Worker reads dimensions
  /// for fallback positioning math; the full MediaSummary is too
  /// large to copy. Only `width` / `height` are needed.
  mediaDims: Record<string, { width: number | null; height: number | null }>;
  /// `media_id → video stream start PTS` in microseconds. Source windows are
  /// normalized to content time; export decoders add this offset when seeking
  /// packets and subtract it when storing decoded frames.
  mediaStartPtsUs: Record<string, number | null>;
  /// `media_id → resolved colour` (`resolveSourceColor`), one complete entry
  /// per media. Applies to the ORIGINAL and proxy decodes alike — a proxy
  /// preserves the source colorimetry. A plain serializable object
  /// (postMessage-safe). The Worker passes it into each `SourceHandle` so
  /// every export lane decodes with the colour preview uses.
  mediaColor: Record<string, SourceColor>;
  /// `media_id → absolute ORIGINAL file path`, resolved on the main thread for
  /// media the export routes through the native decode session. The napi
  /// `exportDecodeOpen` opens a filesystem path (not a `weftcut-media://` asset
  /// URL), and the Worker can't resolve one itself — so the main thread
  /// pre-resolves it here, exactly as it pre-resolves the asset URLs above.
  /// Present only for native-routed media (see `ExportRequest.nativeDecode`).
  originalFilePaths: Record<string, string>;
}

export type ExportRequest =
  | { type: 'resource:result'; id: string; error?: string }
  | {
      type: "start";
      project: ExportProjectSnapshot;
      /// Time range to encode in microseconds (inclusive of
      /// `startUs`, exclusive of `endUs`).
      startUs: number;
      endUs: number;
      /// VideoEncoder config (codec / bitrate / hardware
      /// preference / etc). Main thread builds this from the export settings
      /// in `useExportFlow.ts`; `defaultEncoderConfig` in `runExport.ts` is
      /// the fallback when the caller supplies none.
      encoderConfig: VideoEncoderConfig;
      /// Output frame rate as a rational (overrides composition fps for the
      /// export frame grid + capture cadence). Absent ⇒ use the project's
      /// composition fps.
      outputFpsNum?: number;
      outputFpsDen?: number;
      /// Seconds between forced keyframes. The Worker derives the GOP (frames)
      /// from this at the output fps. Absent ⇒ 1 second.
      keyframeIntervalSec?: number;
      /// OffscreenCanvas transferred from the main thread. Worker
      /// hands it to the PixiJS Application as the render target.
      canvas: OffscreenCanvas;
      /// Pixels arrive in bounded packets, acknowledged after consumption.
      frameWindows?: Record<string, number> | undefined;
      motifStream: boolean;
      /// 10 ⇒ f16/WebGL2 composite precision. Whether frames go to the native
      /// sink is `nativeSink` below — the two are independent (8-bit native
      /// composites RGBA8 but still packs + streams).
      bitDepth?: 8 | 10;
      /// Present ⇒ pack each frame to `pixFmt` and stream raw frames on
      /// `frames` to the ffmpeg video sink (no WebCodecs encoder): the export's
      /// sender worker forwards them to main (docs/export-ipc-transport.md).
      /// Absent ⇒ the WebCodecs EncoderSink/fMP4 path.
      nativeSink?: { pixFmt: SinkPixFmt; frames: MessagePort; readbackFrames: number };
      /// Present ⇒ no encoder at all: every rendered frame is posted as a JPEG
      /// still (`still` events) at `width` px wide — what `render_frames` shows
      /// an agent, composited exactly as export would. Excludes `nativeSink`.
      /// `effects: false` skips clip effects (`render_frames { without }`).
      stills?: { width: number; quality: number; effects?: boolean };
      /// Platform verdict for the 8-bit WebCodecs decode lane, resolved ONCE
      /// on the renderer main thread (the Worker has no OS signal of its own).
      /// True ⇒ the lane may configure prefer-hardware; absent/false ⇒ it pins
      /// prefer-software — the Linux/NVIDIA black-frame workaround. Policy +
      /// rationale: `hwExportDecodeAllowed` (exportDecodeRouting.ts). The
      /// 10-bit lane's preferSoftware pin is a separate correctness
      /// requirement and ignores this flag.
      allowHwExportDecode?: boolean;
      /// mediaIds whose ORIGINAL decodes 10-bit in the renderer; these acquire
      /// originalAssetUrls + tenBitLane + preferSoftware.
      tenBitMedia?: Record<string, boolean>;
      /// The routing table's native slice (population rule + rationale in
      /// exportDecodeRouting.ts). `mediaIds` route through the native
      /// `NativeExportSourceHandle` (decode the ORIGINAL via the napi session
      /// over its own port) instead of the in-worker WebCodecs path;
      /// `outFormat` is those frames' CPU transport format. The Worker stays
      /// policy-free: it just tests membership at acquire time. `window`
      /// bounds the frames each native session has in flight; absent ⇒
      /// engine default.
      nativeDecode?: {
        mediaIds: string[];
        outFormat: ExportTransportFormat;
        window?: number;
      };
      /// Every font the Text layers draw with, FontFace-loaded into the
      /// Worker's `self.fonts` before renderer init, the way preview loads
      /// them (docs/render.md "Fonts"). Bytes are transferred, not copied.
      fonts: {
        /// Bundled font bytes, family → bytes, registered under the family.
        bundled: Record<string, ArrayBuffer>;
        /// The catalog faces `textFaceRefs` names for this summary, each
        /// registered under `faceAlias(ref.sha256)`. A face whose bytes main
        /// could not read is absent: its family falls through, as in preview.
        faces: { ref: FaceRef; bytes: ArrayBuffer }[];
        /// The index the faces were resolved from; Text resolves against it.
        index: FontIndex;
      };
    }
  | { type: "cancel" }
  | { type: "motif:frame"; packet: MotifFramePacket }
  /// Backpressure ack: the main thread finished writing the most recent
  /// `chunk` to disk; the worker's WritableStream may release the next write.
  | { type: "chunk-ack" }
  /// Reply to a prior `nd:open` (correlated by `reqId`). `port` is the
  /// session's own port (transferred): its frames and control come down it,
  /// `range` / `release` go up, and closing it closes the session.
  /// `ok:false` carries the open failure (unsupported format, undecodable
  /// source).
  | { type: "nd:openResult"; reqId: number; ok: true; info: ExportDecodeOpenInfo; port: MessagePort }
  | { type: "nd:openResult"; reqId: number; ok: false; error: string };

/// Aggregate export-perf counters, posted with `done`. Used by the E2E
/// harness to measure decode efficiency (e.g. the long-GOP re-seek redundancy:
/// `totalDispatched` ≫ `totalFrames` means the decoder re-decoded packets).
export interface ExportPerf {
  totalFrames: number;
  /// Sum of packets fed to the source decoder(s) across all chunks. With a
  /// 1:1 export this should be ~`totalFrames`; a large excess is re-decode waste.
  totalDispatched: number;
  /// Count of export-pool handles that were `NativeExportSourceHandle` (media
  /// routed through the in-process native decode session). Always present, 0
  /// when none routed — the native wedge gates assert ≥ 1 so a silent fallback
  /// to the WebCodecs proxy path cannot pass them vacuously.
  nativeHandles: number;
  /// Wall-clock spent preparing/scheduling sources, awaiting decoder output,
  /// and the whole export, in ms. Producer execution overlaps consumption.
  decodeMs: number;
  waitMs: number;
  queueWaitMs?: number;
  totalMs: number;
  /// E2E color diagnostic off the first decoded frame (config vs stamped
  /// colorSpace + format). `ExportColorDiag` from ExportDecoderPool; typed
  /// `unknown` here to avoid coupling the message contract to the decoder.
  colorDiag?: unknown;
  /// Decode target each handle actually opened (original asset URL or proxy
  /// path) — shows when the readiness gate route-corrected onto a lossy proxy.
  sources?: Array<{ mediaId: string; url: string; buffer?: {
    capacityFrames: number; peakFrames: number; waits: number; waitMs: number;
  } }>;
}

export type ExportEvent =
  | { type: 'resource:acquire'; id: string; memoryMiB: number; threads: number }
  | { type: 'resource:release'; id: string }
  | { type: "ready" }
  | { type: "motif:consumed"; index: number }
  | { type: "progress"; framesEncoded: number; totalFrames: number }
  /// One sequential slice of the output file (fMP4, append-only) from the
  /// WebCodecs path; the main thread appends it and replies with chunk-ack.
  | { type: "chunk"; data: ArrayBuffer }
  /// Stills mode: one rendered frame as a JPEG, at output-grid index `index`.
  | { type: "still"; index: number; tUs: number; width: number; height: number; jpeg: ArrayBuffer }
  /// Encode + mux complete; the temp file is fully written on the main side.
  /// `perf` carries aggregate decode/timing counters for the E2E harness.
  | { type: "done"; perf?: ExportPerf }
  | { type: "error"; message: string }
  /// Asks the page to open a native export decode session; answered by
  /// `nd:openResult` with the same `reqId`. No frame and no per-frame message
  /// of the session passes the page.
  | { type: "nd:open"; reqId: number; sessionId: string; path: string; outFormat: ExportTransportFormat; window: number; color: PlaneColor }
  /// Asks the page to end a session. It travels where `nd:open` travels, so a
  /// close reaches main before any open the Worker asks for after it.
  | { type: "nd:close"; sessionId: string };
