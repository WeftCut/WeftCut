// Register raw font bytes into a FontFaceSet so canvas/OffscreenCanvas text
// rasterization can use them. Works on both the main thread (document.fonts)
// and inside a Worker (self.fonts) — FontFace + FontFaceSet.add are available
// in both. MUST be awaited before any PixiJS Text is rasterized, or the first
// frames fall back to a system font (the bundled-font lazy-load gotcha).
// Families resolve to session-stable bytes in the font registry. Registration
// belongs to the document/Worker, not a Compositor: reopening Preview must not
// add another native copy of every font to document.fonts. Weak keys keep an
// independent font set from being retained by this registry.
const registrations = new WeakMap<FontFaceSet, Map<string, Promise<void>>>();

export async function loadFontsIntoFaceSet(
  faceSet: FontFaceSet,
  fonts: Record<string, ArrayBuffer>,
): Promise<void> {
  let registered = registrations.get(faceSet);
  if (!registered) {
    registered = new Map();
    registrations.set(faceSet, registered);
  }
  const families = registered;
  await Promise.all(
    Object.entries(fonts).map(([family, bytes]) => {
      let pending = families.get(family);
      if (!pending) {
        const attempt = (async () => {
          const face = new FontFace(family, bytes);
          await face.load();
          faceSet.add(face);
        })().catch((error: unknown) => {
          // Retry only the failed family; successful siblings stay installed.
          if (families.get(family) === attempt) families.delete(family);
          throw error;
        });
        families.set(family, attempt);
        pending = attempt;
      }
      return pending;
    }),
  );
}
