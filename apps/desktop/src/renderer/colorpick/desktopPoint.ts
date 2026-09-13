/** PointerEvents retain fractional CSS pixels; compatibility MouseEvents don't.
 * Round the physical-pixel round trip (119.99999 is OS pixel 120). */
export function desktopPoint(x: number, y: number, scale: number, width: number, height: number): { x: number; y: number } | null {
  if (![x, y, scale, width, height].every(Number.isFinite) || scale <= 0 || x < 0 || y < 0) return null;
  const px = Math.round(x * scale), py = Math.round(y * scale);
  return px < width && py < height ? { x: px, y: py } : null;
}
