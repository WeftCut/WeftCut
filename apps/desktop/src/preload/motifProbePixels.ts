import { sameRgba } from '../shared/motifs/gpuProbe';

export async function decodeProbePng(base64: string): Promise<ImageBitmap> {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}
/** Full readback is confined to self-test, never the selected export path. */
export async function matchesProbePng(bitmap: ImageBitmap, base64: string): Promise<boolean> {
  const reference = await decodeProbePng(base64);
  try {
    if (bitmap.width !== reference.width || bitmap.height !== reference.height) return false;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(bitmap, 0, 0);
    const actual = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    ctx.clearRect(0, 0, bitmap.width, bitmap.height); ctx.drawImage(reference, 0, 0);
    return sameRgba(actual, ctx.getImageData(0, 0, bitmap.width, bitmap.height).data);
  } finally { reference.close(); }
}
