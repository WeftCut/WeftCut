// Shared across all picker instances, including concurrent mounts and remounts.
// This caches names only; render/fonts/registry remains the font-byte authority.
let families: Promise<string[]> | null = null;

export function getSystemFontFamilies(): Promise<string[]> {
  return families ??= Promise.resolve().then(() => window.api.font.listFamilies())
    .catch((error: unknown) => {
      families = null;
      throw error;
    });
}
