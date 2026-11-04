// CPU reference for behaviour tests and comparison against actual GPU pixels.
export function highlightsReference(src: [number, number, number, number], percentage: number): number[] {
  const amount = Math.max(-1, Math.min(1, percentage / 100));
  if (amount === 0 || src[3] < 0.0001) return [...src];
  const rgb = src.slice(0, 3).map(v => Math.max(0, Math.min(1, v / src[3])));
  const peak = Math.max(...rgb);
  const tone = (rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722 + peak) / 2;
  const low = .45;
  if (tone <= low) return [...src];
  const t = (tone - low) / (1 - low);
  const mapped = low + (1 - low) * (amount < 0
    ? t + 1.6 * amount * t * t * (1 - t)
    : t + amount * Math.pow(t, 1.25) * (1 - t));
  const scale = Math.min(mapped / tone, 1 / peak);
  return [...rgb.map(v => v * scale * src[3]), src[3]];
}
