/** Retained rectangle in normalized, untransformed source coordinates.
 * Independent of decoded/proxy dimensions; null retains the entire source. */
export interface CropRect { x: number; y: number; w: number; h: number }
export const FULL_CROP: Readonly<CropRect> = { x: 0, y: 0, w: 1, h: 1 };
export const CROP_MIN = 0.000001;

export function cropProblem(value: unknown): string | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'crop must be null or { x, y, w, h }';
  const r = value as CropRect;
  if (Object.keys(r).some(k => !['x', 'y', 'w', 'h'].includes(k))) return 'crop only accepts x, y, w, h';
  if (![r.x, r.y, r.w, r.h].every(v => typeof v === 'number' && Number.isFinite(v))) return 'crop coordinates must be finite numbers';
  if (r.x < 0 || r.y < 0 || r.w < CROP_MIN || r.h < CROP_MIN || r.x + r.w > 1 + 1e-10 || r.y + r.h > 1 + 1e-10)
    return 'crop must retain a positive rectangle inside the source (normalized 0..1)';
  return null;
}

export function canonicalCrop(r: CropRect | null): CropRect | null {
  if (!r) return null;
  // Keep source-pixel edits stable to 0.001 px even on 8K sources.
  const q = (v: number) => Math.round(v * 1e9) / 1e9;
  const x = q(r.x), y = q(r.y);
  const w = q(Math.min(1 - x, Math.max(CROP_MIN, r.w)));
  const h = q(Math.min(1 - y, Math.max(CROP_MIN, r.h)));
  return x === 0 && y === 0 && w === 1 && h === 1 ? null : { x, y, w, h };
}

export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Delta is in normalized source coordinates. */
export function dragCrop(r: CropRect, handle: CropHandle, dx: number, dy: number): CropRect {
  if (handle === 'move') return { ...r, x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h) };
  let l = r.x, t = r.y, b = t + r.h, right = l + r.w;
  if (handle.includes('w')) l = clamp(l + dx, 0, right - CROP_MIN);
  if (handle.includes('e')) right = clamp(right + dx, l + CROP_MIN, 1);
  if (handle.includes('n')) t = clamp(t + dy, 0, b - CROP_MIN);
  if (handle.includes('s')) b = clamp(b + dy, t + CROP_MIN, 1);
  return { x: l, y: t, w: right - l, h: b - t };
}
