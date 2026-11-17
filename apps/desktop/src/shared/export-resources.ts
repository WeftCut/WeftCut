import type { ResourceHolder } from './resource-policy';
/** Plans describe simultaneous allocations, never output quality. */
export interface ExportResourcePlan {
  memoryMiB: number;
  workerMiB: number;
  motifBufferBytes: number;
  motifFrames?: number;
  frameWindows: Record<string, number>;
  /** `exportReadbackFrames` for this export; it sizes the readback ring. */
  readbackFrames: number;
}
export type ResourceWaitReason = 'busy' | 'pressure' | 'host-pressure' | 'budget-too-small';
export interface ExportResourceBlock {
  kind: 'blocked'; reason: ResourceWaitReason;
  requestedMiB: number; availableMiB: number; workMiB: number; revision: number;
  /** What held the budget when admission refused, largest first. */
  holders?: ResourceHolder[];
}
export type ExportAdmission = ExportResourceBlock | { kind: 'admitted'; id: number; index: number };
export interface ExportPlanRequest { id: string; options: number[]; nativeEncoder: boolean }
export const resourceBlockError = (block: ExportResourceBlock) =>
  new Error(`resource-capacity-exceeded: ${JSON.stringify(block)}`);
export function resourceFailureReason(error: unknown): ResourceWaitReason | undefined {
  const match = String(error).match(/"reason":"(busy|pressure|host-pressure|budget-too-small)"/);
  return match?.[1] as ResourceWaitReason | undefined;
}

/** Working memory of the audio mix + encode tail. It runs under its export's
 * admitted plan and borrows from it (native `resources::EXPORT_AUDIO_MIX_MIB`),
 * alongside the video, so every plan of an export with audio adds it. */
export const EXPORT_AUDIO_MIX_MIB = 128;

/** The rawvideo layouts the native sink takes from the pack passes. */
export type SinkPixFmt = 'yuv420p' | 'yuv420p10le' | 'yuv422p' | 'yuv422p10le';

/** Bytes of one packed frame per output pixel. */
export function sinkBytesPerPixel(pixFmt: SinkPixFmt): number {
  const samples = pixFmt.startsWith('yuv422') ? 2 : 1.5;
  return pixFmt.endsWith('10le') ? samples * 2 : samples;
}

/** Packed frames a native-sink export reads back per GPU wait, and at most in
 * flight to the encoder. Two hide the wait behind the next frame's work; four
 * added about 5% at 1080p and lost at 4K (docs/notes/export-pipeline-2026-11.md).
 *
 * LANDMINE: with Motif layers, frames left unread on the GPU stall the next
 * Motif frames on Windows (warm 1080p export: 65 fps at 1, 38 at 2, 21 at 4).
 * The stall is inside Chromium's GPU scheduling and was not isolated; read
 * every frame back before the next one while a Motif plays. */
export function exportReadbackFrames(hasMotifs: boolean): number {
  return hasMotifs ? 1 : 2;
}

export const EXPORT_FRAME_WINDOW = 24;
export const EXPORT_PRIVATE_FRAMES = 16;
export function exportDecoderMiB(width: number, height: number, tenBit: boolean, frames: number): number {
  return Math.ceil(64 + width * height * (tenBit ? 8 : 4) * (frames + EXPORT_PRIVATE_FRAMES) / 1048576);
}

/** The fewest frames `minimumExportFrames` answers: a one-picture DPB plus
 * the eight-picture headroom. */
export const EXPORT_MIN_FRAMES = 9;

/** AVC Annex A DPB bound + the existing eight-picture pipeline headroom.
 * Unknown codecs/levels keep the shipping 24 credits. Private/reference surface
 * accounting remains 16 pictures even when the dispatch window is smaller.
 * https://chromium.googlesource.com/chromium/src/+/581b9e8403fdba9f33cc315c56180f841407c86b/media/video/h264_level_limits.cc
 */
export function minimumExportFrames(config: { codec: string; codedWidth?: number; codedHeight?: number }): number {
  const match = /^(?:avc1|avc3)\.[\da-f]{4}([\da-f]{2})$/i.exec(config.codec);
  const limits: Record<number, number> = { 10:396, 11:900, 12:2376, 13:2376, 20:2376, 21:4752, 22:8100, 30:8100, 31:18000, 32:20480, 40:32768, 41:32768, 42:34816, 50:110400, 51:184320, 52:184320, 60:696320, 61:696320, 62:696320 };
  const maxDpbMbs = match ? limits[Number.parseInt(match[1]!, 16)] : undefined;
  const { codedWidth: w, codedHeight: h } = config;
  if (!maxDpbMbs || !w || !h || w < 1 || h < 1) return EXPORT_FRAME_WINDOW;
  const dpb = Math.floor(maxDpbMbs / (Math.ceil(w / 16) * Math.ceil(h / 16)));
  if (dpb < 1) return EXPORT_FRAME_WINDOW;
  return Math.min(16, dpb) + 8;
}
