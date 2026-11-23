// The family names a font picker offers: the open project's `Fonts/` and the
// system's (`font:listFamilies`). Shared across all picker instances,
// including concurrent mounts and remounts, and refetched when the face index
// changes (a project opened, the system scan landed). This caches names only;
// render/fonts/registry.ts remains the font-byte authority.

let families: { revision: number; names: Promise<string[]> } | null = null;

/// `revision` is the font index revision the caller rendered with.
export function getFontFamilies(revision: number): Promise<string[]> {
  if (families?.revision === revision) return families.names;
  const names = Promise.resolve()
    .then(() => window.api.font.listFamilies())
    .catch((error: unknown) => {
      if (families?.names === names) families = null;
      throw error;
    });
  families = { revision, names };
  return names;
}
