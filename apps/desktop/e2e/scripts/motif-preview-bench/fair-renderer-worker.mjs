// Lanes d1/d2 of the fair comparison: the renderer-side reader. It checks the
// header, decompresses, verifies BLAKE3 over the pixels exactly as the native
// reader does (motif_frame.rs), downscales and returns an ImageBitmap.
import { downscale } from './downscale.mjs';

let fzstd, zstd, hasher;
const MAGIC = [0x57, 0x43, 0x4d, 0x46, 0x52, 0x4d, 0x30, 0x31]; // WCMFRM01

onmessage = async ({ data }) => {
  if (data.init) {
    try {
      fzstd = await import(data.init.fzstd);
      const { ZSTDDecoder } = await import(data.init.zstddec);
      zstd = new ZSTDDecoder();
      await zstd.init();
      const { createBLAKE3 } = await import(data.init.hash);
      hasher = await createBLAKE3();
      postMessage({ id: data.id });
    } catch (error) { postMessage({ id: data.id, error: String(error?.stack ?? error) }); }
    return;
  }
  const { id, bytes, decoder, div } = data;
  try {
    const t0 = performance.now();
    if (bytes.byteLength < 52 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('Not a Motif frame');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(8, true), height = view.getUint32(12, true), codec = view.getUint32(16, true);
    if (codec !== 2) throw new Error(`Unsupported Motif frame codec ${codec}`);
    const size = width * height * 4, payload = bytes.subarray(52);
    // zstddec reports a failure as a size, so the length check is the error check.
    const rgba = decoder === 'fzstd' ? fzstd.decompress(payload, new Uint8Array(size)) : zstd.decode(payload, size);
    if (rgba.byteLength !== size) throw new Error('Motif frame payload has the wrong size');
    const t1 = performance.now();
    hasher.init();
    hasher.update(rgba);
    const digest = hasher.digest('binary');
    for (let i = 0; i < 32; i++) if (digest[i] !== bytes[20 + i]) throw new Error('Motif frame checksum mismatch');
    const t2 = performance.now();
    const scaled = downscale(rgba, width, height, div);
    const t3 = performance.now();
    const pixels = new Uint8ClampedArray(scaled.rgba.buffer, scaled.rgba.byteOffset, scaled.rgba.byteLength);
    const bitmap = await createImageBitmap(new ImageData(pixels, scaled.width, scaled.height));
    const t4 = performance.now();
    postMessage({ id, bitmap, stages: { decodeMs: t1 - t0, hashMs: t2 - t1, scaleMs: t3 - t2, bitmapMs: t4 - t3 } }, [bitmap]);
  } catch (error) { postMessage({ id, error: String(error?.message ?? error) }); }
};
