// Alpha-weighted box downscale of straight RGBA by an integer divisor. Every
// candidate lane in the fair comparison uses this one function, so lanes differ
// only in where it runs. Colour is averaged by alpha: a fully transparent texel
// carries no colour and never darkens an edge.
export function downscale(rgba, width, height, div) {
  if (div === 1) return { width, height, rgba };
  if (width % div || height % div) throw new Error(`Size ${width}×${height} is not divisible by ${div}`);
  const w = width / div, h = height / div, n = div * div, stride = width * 4;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, r = 0, g = 0, b = 0;
      for (let dy = 0; dy < div; dy++) {
        let p = (y * div + dy) * stride + x * div * 4;
        for (let dx = 0; dx < div; dx++, p += 4) {
          const alpha = rgba[p + 3];
          a += alpha; r += rgba[p] * alpha; g += rgba[p + 1] * alpha; b += rgba[p + 2] * alpha;
        }
      }
      const q = (y * w + x) * 4;
      if (a) { out[q] = Math.round(r / a); out[q + 1] = Math.round(g / a); out[q + 2] = Math.round(b / a); }
      out[q + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, rgba: out };
}

/// Largest per-channel difference between two straight-RGBA images, compared
/// premultiplied: a canvas readback unpremultiplies, which loses colour
/// precision at low alpha that no lane can be blamed for.
export function premultipliedDiff(expected, actual) {
  if (expected.length !== actual.length) throw new Error(`Length ${actual.length} ≠ ${expected.length}`);
  let max = 0, over = 0, alphaMax = 0;
  for (let p = 0; p < expected.length; p += 4) {
    const ea = expected[p + 3], aa = actual[p + 3];
    const da = Math.abs(ea - aa);
    if (da > alphaMax) alphaMax = da;
    let worst = da;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(Math.round(expected[p + k] * ea / 255) - Math.round(actual[p + k] * aa / 255));
      if (d > worst) worst = d;
    }
    if (worst > max) max = worst;
    if (worst > 2) over++;
  }
  return { max, alphaMax, over };
}
