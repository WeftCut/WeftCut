let decoder;
onmessage = async ({ data: { id, compressed, width, height, decoderUrl } }) => {
  try {
    const { decompress } = await (decoder ??= import(decoderUrl));
    const start = performance.now();
    const rgba = decompress(compressed);
    const afterDecode = performance.now();
    const src = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
    const pixels = new Uint8ClampedArray(width*height);
    const dst = new Uint32Array(pixels.buffer);
    for (let y = 0; y < height/2; y++) for (let x = 0; x < width/2; x++) dst[y*(width/2)+x] = src[y*2*width+x*2];
    const bitmap = await createImageBitmap(new ImageData(pixels, width/2, height/2));
    postMessage({ id, bitmap, decodeMs: afterDecode-start, workerMs: performance.now()-start }, [bitmap]);
  } catch (e) { postMessage({ id, error: String(e.stack) }); }
};
