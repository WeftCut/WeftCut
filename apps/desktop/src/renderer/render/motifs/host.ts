import { invoke } from "@/bridge/ipc";
import { captureMotif } from './frameTransport';

/**
 * Render a Motif to a single frame and return the raw PNG as a `Blob`.
 *
 * Drives the `motif_capture_frame` IPC channel: main encodes the leased paint
 * of the offscreen capture host as a PNG (ADR 0159), at `background` priority.
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
    fpsNum: fpsNum ?? null,
    fpsDen: fpsDen ?? null,
  });
  return new Blob([bytes as BlobPart], { type: "image/png" });
}

/**
 * Capture to a fresh ImageBitmap through the preload transport: a shared GPU
 * texture on Windows, straight RGBA elsewhere (ADR 0159). Unaddressed, so main
 * neither stores nor deduplicates it. Used by the e2e hook; the editor goes
 * through `acquireMotifFrame`.
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
): Promise<ImageBitmap> {
  const reply = await captureMotif({
    motifId, tSec, propsJson: JSON.stringify(props), width, height,
    contentHash: contentHash ?? "", priority: "current",
  }).reply;
  // An unaddressed capture always carries pixels.
  if (reply.kind !== "pixels") throw new Error("Motif capture returned no frame");
  return reply.bitmap;
}
