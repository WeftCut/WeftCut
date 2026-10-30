// Procedural Motif frames for the fair transport comparison. Deterministic, so
// every platform compares the same pixels. Straight RGBA, as Motif frames are
// stored. Two tiers beside the existing sparse box:
//   typical — an overlay: gradient lower third, soft-edged glyph strokes with a
//             drop shadow, a radial badge. Mostly transparent.
//   dense   — a full-canvas colour field with per-pixel noise and varying alpha,
//             close to incompressible (the "dense Canvas" end of real content).

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Source-over in straight alpha.
function blend(rgba, p, r, g, b, alpha) {
  if (alpha <= 0) return;
  const da = rgba[p + 3] / 255, oa = alpha + da * (1 - alpha);
  const keep = da * (1 - alpha);
  rgba[p] = Math.round((r * alpha + rgba[p] * keep) / oa);
  rgba[p + 1] = Math.round((g * alpha + rgba[p + 1] * keep) / oa);
  rgba[p + 2] = Math.round((b * alpha + rgba[p + 2] * keep) / oa);
  rgba[p + 3] = Math.round(oa * 255);
}

// An axis-aligned rectangle with a linear soft edge `soft` pixels wide.
function softRect(rgba, width, height, x0, y0, x1, y1, soft, [r, g, b], alpha) {
  const xa = Math.max(0, Math.floor(x0 - soft)), xb = Math.min(width, Math.ceil(x1 + soft));
  const ya = Math.max(0, Math.floor(y0 - soft)), yb = Math.min(height, Math.ceil(y1 + soft));
  for (let y = ya; y < yb; y++) {
    const cy = Math.min(1, Math.max(0, Math.min(y + 0.5 - y0, y1 - y - 0.5) / soft + 0.5));
    for (let x = xa; x < xb; x++) {
      const cx = Math.min(1, Math.max(0, Math.min(x + 0.5 - x0, x1 - x - 0.5) / soft + 0.5));
      blend(rgba, (y * width + x) * 4, r, g, b, alpha * cx * cy);
    }
  }
}

export function typicalFrame(width, height, frame) {
  const rgba = new Uint8Array(width * height * 4);
  const s = width / 3840;
  // Lower third: a horizontal alpha gradient band.
  const top = Math.round(height * 0.68), bottom = Math.round(height * 0.9);
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < width; x++) {
      const t = x / width, v = (y - top) / (bottom - top);
      blend(rgba, (y * width + x) * 4, 12 + 40 * v, 24 + 30 * t, 64 + 60 * v * t, (0.75 - 0.4 * t) * (0.6 + 0.4 * Math.sin(v * Math.PI)));
    }
  }
  // Lines of "glyphs" (2–4 strokes each, soft drop shadow): two in the lower
  // third, two as a title near the top.
  const rand = random(7);
  for (let line = 0; line < 4; line++) {
    let x = 160 * s + ((frame * 23) % 97) * s;
    const baseline = line < 2 ? top + (70 + line * 150) * s : (180 + (line - 2) * 150) * s;
    while (x < width * 0.85) {
      const strokes = 2 + Math.floor(rand() * 3), w = (30 + rand() * 40) * s;
      for (let k = 0; k < strokes; k++) {
        const vertical = rand() < 0.5;
        const sx = x + rand() * w, sy = baseline + rand() * 60 * s;
        const [x0, y0, x1, y1] = vertical ? [sx, sy, sx + 9 * s, sy + 70 * s] : [x, sy, x + w, sy + 9 * s];
        softRect(rgba, width, height, x0 + 6 * s, y0 + 6 * s, x1 + 6 * s, y1 + 6 * s, 6 * s, [0, 0, 0], 0.45);
        softRect(rgba, width, height, x0, y0, x1, y1, 1.5 * s, [250, 246, 236], 1);
      }
      x += w + (14 + rand() * 30) * s;
    }
  }
  // A radial badge orbiting the top-right corner.
  const cx = width * 0.82 + Math.cos(frame / 5) * 80 * s, cy = height * 0.18 + Math.sin(frame / 5) * 40 * s, radius = 170 * s;
  for (let y = Math.floor(cy - radius); y < cy + radius; y++) {
    for (let x = Math.floor(cx - radius); x < cx + radius; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / radius;
      if (d >= 1) continue;
      blend(rgba, (y * width + x) * 4, 240 - d * 120, 120 + d * 80, 60, Math.min(1, (1 - d) * 4) * 0.9);
    }
  }
  // Soft particles drifting across the frame.
  const drift = random(99);
  for (let k = 0; k < 400; k++) {
    const px = (drift() * width + frame * 11 * s) % width, py = drift() * height, pr = (4 + drift() * 18) * s;
    for (let y = Math.max(0, Math.floor(py - pr)); y < Math.min(height, py + pr); y++) {
      for (let x = Math.max(0, Math.floor(px - pr)); x < Math.min(width, px + pr); x++) {
        const d = Math.hypot(x + 0.5 - px, y + 0.5 - py) / pr;
        if (d < 1) blend(rgba, (y * width + x) * 4, 255, 230, 180, (1 - d) * (1 - d) * 0.8);
      }
    }
  }
  return rgba;
}

export function denseFrame(width, height, frame) {
  const rgba = new Uint8Array(width * height * 4);
  const rand = random(1000 + frame);
  const cx = width / 2, cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4, n = (rand() - 0.5) * 24;
      rgba[p] = Math.max(0, Math.min(255, Math.round(128 + 100 * Math.sin(x * 0.004 + frame * 0.3) + n)));
      rgba[p + 1] = Math.max(0, Math.min(255, Math.round(128 + 100 * Math.sin(y * 0.005 + x * 0.002) - n)));
      rgba[p + 2] = Math.max(0, Math.min(255, Math.round(128 + 100 * Math.cos((x + y) * 0.003) + n / 2)));
      const d = Math.hypot(x - cx, y - cy);
      rgba[p + 3] = Math.max(0, Math.min(255, Math.round(160 + 95 * Math.sin(d * 0.01 - frame * 0.2) + (rand() - 0.5) * 12)));
    }
  }
  return rgba;
}
