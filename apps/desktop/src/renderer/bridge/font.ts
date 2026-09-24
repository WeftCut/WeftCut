// Renderer-side bridge wrappers for the font IPC surface (window.api.font).
// Thin pass-through functions so callers import from here rather than
// reaching through window.api directly — consistent with the other bridge
// modules (dialog.ts, fs.ts, shell.ts, …).

/// Best-effort OS font-file lookup by family name; null when not found.
export function fontResolve(family: string): Promise<Uint8Array | null> {
  return window.api.font.resolve(family)
}

/// Copy a .ttf/.otf/.woff2 file into <userData>/fonts/ and return the
/// resolved family name + destination filename. Throws on unsupported
/// format or unreadable name table.
export function fontImport(
  srcPath: string,
): Promise<{ family: string; filename: string }> {
  return window.api.font.import(srcPath)
}

/// List every font previously imported into <userData>/fonts/.
export function fontListImported(): Promise<{ family: string; filename: string }[]> {
  return window.api.font.listImported()
}
