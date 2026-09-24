// Renderer bridge for the font IPC surface (window.api.font).
// Thin wrappers — consistent with dialog.ts, fs.ts, shell.ts.

/** Best-effort OS + imported font-file lookup by family name; null when not found. */
export function fontResolve(family: string): Promise<Uint8Array | null> {
  return window.api.font.resolve(family)
}

/** Copy a .ttf/.otf into <userData>/fonts/ and return the family name + filename. */
export function fontImport(srcPath: string): Promise<{ family: string; filename: string }> {
  return window.api.font.import(srcPath)
}

/** List every font previously imported into <userData>/fonts/. */
export function fontListImported(): Promise<{ family: string; filename: string }[]> {
  return window.api.font.listImported()
}

/** Import a font via file-picker dialog, register it in document.fonts for
 *  immediate rendering, and return the family name. Returns null if the user
 *  cancelled. Re-throws import errors. */
export async function pickAndImportFont(
  dialogTitle: string,
): Promise<{ family: string; filename: string } | null> {
  const picked = await window.api.dialog.open({
    title: dialogTitle,
    filters: [{ name: "Font files", extensions: ["ttf", "otf"] }],
  })
  if (!picked || Array.isArray(picked)) return null

  const result = await window.api.font.import(picked)

  // Register in document.fonts so PixiJS renders the font immediately.
  const bytes = await window.api.font.resolve(result.family)
  if (bytes) {
    const face = new FontFace(result.family, bytes.buffer as ArrayBuffer)
    await face.load()
    document.fonts.add(face)
  }

  return result
}
