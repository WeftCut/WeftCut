const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/// Bytes as the largest unit that keeps the number under 1024: a file's size
/// as the media panel and the Motif trust card show it. Export estimates use
/// the decimal `formatBytes` in `shared/exportSettings.ts`.
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit] ?? BYTE_UNITS[0]}`;
}
