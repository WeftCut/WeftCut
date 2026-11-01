// CPU reference for behaviour tests and comparison against actual GPU pixels.
export function highlightsReference(src: [number, number, number, number], percentage: number): number[] {
  const amount = Math.max(-1, Math.min(1, percentage / 100));
  if (amount === 0 || src[3] < 0.0001) return [...src];
  const rgb = src.slice(0, 3).map((v) => v / src[3]);
  const luma = rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  const low = 0.30;
  if (luma <= low) return [...src];
  const delta = luma - low;
  const position = delta / (1 - low);
  const curve = amount < 0 ? -4 * amount : -.8 * amount;
  const mapped = low + delta / Math.max(1 + curve * position, .0001);
  const scale = mapped / luma;
  return [...rgb.map((v) => Math.max(0, Math.min(1, v * scale)) * src[3]), src[3]];
}
