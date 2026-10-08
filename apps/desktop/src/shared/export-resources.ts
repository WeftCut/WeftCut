/** Plans describe simultaneous allocations, never output quality. */
export interface ExportResourcePlan {
  memoryMiB: number;
  workerMiB: number;
  motifBufferBytes: number;
  motifFrames?: number;
  frameWindows: Record<string, number>;
}
export type ResourceWaitReason = 'busy' | 'pressure' | 'host-pressure' | 'budget-too-small';
export interface ExportResourceBlock {
  kind: 'blocked'; reason: ResourceWaitReason;
  requestedMiB: number; availableMiB: number; workMiB: number; revision: number;
}
export type ExportAdmission = ExportResourceBlock | { kind: 'admitted'; id: number; index: number };
export interface ExportPlanRequest { id: string; options: number[]; nativeEncoder: boolean }
export const resourceBlockError = (block: ExportResourceBlock) =>
  new Error(`resource-capacity-exceeded: ${JSON.stringify(block)}`);
export function resourceFailureReason(error: unknown): ResourceWaitReason | undefined {
  const match = String(error).match(/"reason":"(busy|pressure|host-pressure|budget-too-small)"/);
  return match?.[1] as ResourceWaitReason | undefined;
}

export const EXPORT_FRAME_WINDOW = 24;
export const EXPORT_PRIVATE_FRAMES = 16;
export function exportDecoderMiB(width: number, height: number, tenBit: boolean, frames: number): number {
  return Math.ceil(64 + width * height * (tenBit ? 8 : 4) * (frames + EXPORT_PRIVATE_FRAMES) / 1048576);
}

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
