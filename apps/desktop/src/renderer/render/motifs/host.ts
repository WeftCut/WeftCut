import { invoke } from "@/bridge/ipc";
import { CAPTURE_SUPERSEDED_MESSAGE } from "../../../shared/motifs/captureErrors";
import { captureMotifResult, type CapturedFrame } from './frameTransport';
import type { MotifCacheAddress } from '../../../shared/motifs/frameTransport';
import type { MotifReaderDiv } from '../../../shared/motifs/readerProtocol';

export interface CaptureOptions {
  key: string;
  high: boolean;
  bake?: MotifCacheAddress;
  cache?: MotifCacheAddress;
  finalizationToken?: string;
  /** The divisor a `stored` reply is read at; 1 when absent. A live capture
   * is always full size. */
  scaleDiv?: MotifReaderDiv;
}

export function captureMotifFrameResult(
  motifId: string, tSec: number, props: Record<string, unknown>, width: number, height: number,
  contentHash: string | undefined,
  fpsNum: number | undefined, fpsDen: number | undefined, options: CaptureOptions,
): Promise<CapturedFrame> {
  const perf = (window as unknown as { __weftcutMotifPerf?: { renders: number } }).__weftcutMotifPerf;
  if (perf) perf.renders++;
  return captureMotifResult({
    motifId, tSec, propsJson: JSON.stringify(props), width, height,
    contentHash: contentHash ?? '', fpsNum, fpsDen,
    coalesceKey: options.key, high: options.high, bake: options.bake,
    cache: options.cache,
    finalizationToken: options.finalizationToken,
  }, options.scaleDiv ?? 1);
}

/**
 * Render a Motif to a single frame and return the raw PNG as a `Blob`.
 *
 * Drives the `motif_capture_frame` IPC channel: main encodes the leased paint
 * of the offscreen capture host as a PNG (ADR 0159).
 *
 * @param motifId    built-in Motif id (e.g. "countdown")
 * @param tSec       content time in SECONDS
 * @param props      Motif props (will be JSON-serialized for the IPC boundary)
 * @param width      capture width in pixels
 * @param height     capture height in pixels
 * @param contentHash optional blake3 content hash — threaded to the host URL's
 *                    `?v=` cache-buster so an in-place draft edit reloads the
 *                    capture host (else it re-captures the stale loaded DOM).
 * @param fpsNum/fpsDen optional composition fps (exact rational) — becomes the
 *                    `meta.fps` a Motif script reads; must be the rate `tSec`
 *                    was computed on. Absent → main falls back to 30.
 */
export async function captureMotifFramePngBlob(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  contentHash?: string,
  coalesceKey?: string,
  fpsNum?: number,
  fpsDen?: number,
): Promise<Blob> {
  // The channel returns the PNG bytes as a Uint8Array (structured-clone
  // native), so this side pays no atob/byte-copy.
  const bytes = await invoke<Uint8Array>("motif_capture_frame", {
    motifId,
    tSec,
    propsJson: JSON.stringify(props),
    width,
    height,
    contentHash: contentHash ?? "",
    // Latest-wins queueing on the serial capture chain (main/motif/capture.ts):
    // a newer same-key request replaces a still-queued older one.
    coalesceKey: coalesceKey ?? null,
    fpsNum: fpsNum ?? null,
    fpsDen: fpsDen ?? null,
  });
  return new Blob([bytes as BlobPart], { type: "image/png" });
}

/**
 * Capture to a fresh ImageBitmap through the preload transport: a shared GPU
 * texture on Windows, straight RGBA elsewhere (ADR 0159). Used by the e2e
 * hook; the editor goes through `captureMotifFrameResult`.
 *
 * @param motifId    built-in Motif id (e.g. "countdown")
 * @param tSec       content time in SECONDS
 * @param props      Motif props (will be JSON-serialized for the IPC boundary)
 * @param width      capture width in pixels
 * @param height     capture height in pixels
 * @param contentHash optional blake3 content hash — threaded to the host URL's
 *                    `?v=` cache-buster (see `captureMotifFramePngBlob`).
 */
export async function captureMotifFrame(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  contentHash?: string,
  coalesceKey?: string,
  fpsNum?: number,
  fpsDen?: number,
): Promise<ImageBitmap> {
  const { captureStoredMotifFrame } = await import("./frameTransport");
  return captureStoredMotifFrame({
    motifId, tSec, propsJson: JSON.stringify(props), width, height,
    contentHash: contentHash ?? "",
    coalesceKey, fpsNum, fpsDen,
  });
}

/// True when a capture rejection is the chain's latest-wins replacement
/// (CAPTURE_SUPERSEDED_MESSAGE), i.e. NOT a capture failure — callers must not
/// count it against retry budgets or log it as an error.
export function isCaptureSuperseded(e: unknown): boolean {
  return String(e).includes(CAPTURE_SUPERSEDED_MESSAGE);
}
