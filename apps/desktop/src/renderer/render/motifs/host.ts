import { invoke } from "@/bridge/ipc";
import { CAPTURE_SUPERSEDED_MESSAGE } from "../../../shared/motifs/captureErrors";

/**
 * Render a Motif to a single frame and return the raw PNG as a `Blob`.
 *
 * Drives the `motif_capture_frame` IPC channel (offscreen Electron window
 * + `motif:` scheme + CDP `Page.captureScreenshot` via webContents.debugger).
 * The PNG is taint-free (CDP screenshot, not a canvas readback).
 *
 * @param motifId    built-in Motif id (e.g. "countdown")
 * @param tSec       content time in SECONDS
 * @param props      Motif props (will be JSON-serialized for the IPC boundary)
 * @param width      capture width in pixels
 * @param height     capture height in pixels
 * @param settleRafs optional extra rAF settle count before capture
 * @param contentHash optional blake3 content hash — threaded to the host URL's
 *                    `?v=` cache-buster so an in-place draft edit reloads the
 *                    capture host (else it re-captures the stale loaded DOM).
 */
export async function captureMotifFramePngBlob(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
  contentHash?: string,
  coalesceKey?: string,
): Promise<Blob> {
  const b64: string = await invoke("motif_capture_frame", {
    motifId,
    tSec,
    propsJson: JSON.stringify(props),
    width,
    height,
    settleRafs: settleRafs ?? null,
    contentHash: contentHash ?? "",
    // Latest-wins queueing on the serial capture chain (main/motif/capture.ts):
    // a newer same-key request replaces a still-queued older one.
    coalesceKey: coalesceKey ?? null,
  });
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}

/**
 * As `captureMotifFramePngBlob`, decoded to an `ImageBitmap` for GPU upload.
 *
 * The bitmap can be uploaded to WebGPU/Pixi without cross-origin tainting.
 *
 * @param motifId    built-in Motif id (e.g. "countdown")
 * @param tSec       content time in SECONDS
 * @param props      Motif props (will be JSON-serialized for the IPC boundary)
 * @param width      capture width in pixels
 * @param height     capture height in pixels
 * @param settleRafs optional extra rAF settle count before capture
 * @param contentHash optional blake3 content hash — threaded to the host URL's
 *                    `?v=` cache-buster (see `captureMotifFramePngBlob`).
 */
export async function captureMotifFrame(
  motifId: string,
  tSec: number,
  props: Record<string, unknown>,
  width: number,
  height: number,
  settleRafs?: number,
  contentHash?: string,
  coalesceKey?: string,
): Promise<ImageBitmap> {
  const blob = await captureMotifFramePngBlob(motifId, tSec, props, width, height, settleRafs, contentHash, coalesceKey);
  return createImageBitmap(blob);
}

/// True when a capture rejection is the chain's latest-wins replacement
/// (CAPTURE_SUPERSEDED_MESSAGE), i.e. NOT a capture failure — callers must not
/// count it against retry budgets or log it as an error.
export function isCaptureSuperseded(e: unknown): boolean {
  return String(e).includes(CAPTURE_SUPERSEDED_MESSAGE);
}
