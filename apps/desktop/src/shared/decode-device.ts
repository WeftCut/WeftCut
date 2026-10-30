/** Machine-local preview preference, never project or media metadata. */
export function validDecodeDevice(value: unknown): value is string {
  return typeof value === 'string' && (value === 'auto' || value === 'cpu' || /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i.test(value));
}
export const readDecodeDevice = (value: unknown): string => validDecodeDevice(value) ? value.toLowerCase() : 'auto';
