import path from "node:path";
import { app } from "electron";
import { BUILTIN_IDS } from "../../shared/motifs/catalog";
import type { UserMotifStore } from "./store";
import { readMotifFile } from './packageFiles';

/**
 * PRODUCTION-ONLY: base dir of built-in served assets. Mirrors the ffmpeg-sidecar
 * resolution (`src/main/index.ts`): packaged → `<resources>/motifs/builtin`;
 * dev → `apps/desktop/src/shared/motifs/builtin` relative to the bundled main
 * (`import.meta.dirname = apps/desktop/out/main`, so `../../src/...`).
 */
export function builtinAssetDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "motifs", "builtin")
    : path.join(import.meta.dirname, "../../src/shared/motifs/builtin");
}

/** Guess a Content-Type from a file extension. */
export function contentTypeFor(rel: string): string {
  const ext = (rel.split(".").pop() ?? "").toLowerCase();
  switch (ext) {
    case "html": case "htm": return "text/html; charset=utf-8";
    case "js": case "mjs": return "text/javascript; charset=utf-8";
    case "css": return "text/css; charset=utf-8";
    case "json": return "application/json; charset=utf-8";
    case "gltf": return "model/gltf+json";
    case "glb": return "model/gltf-binary";
    case "wasm": return "application/wasm";
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "woff2": return "font/woff2";
    case "woff": return "font/woff";
    case "ttf": return "font/ttf";
    case "otf": return "font/otf";
    default: return "application/octet-stream";
  }
}

/**
 * Resolve `motif://<id>/<rest>` to bytes + content-type. Embedded built-ins win;
 * the on-disk user store is the fallback. `builtinDir` is passed EXPLICITLY (the
 * caller — index.ts — computes it via `builtinAssetDir()`; tests pass a fixture dir).
 */
export function resolveMotifFile(
  builtinDir: string,
  store: UserMotifStore,
  id: string,
  rest: string,
): { bytes: Buffer; contentType: string } | null {
  if (BUILTIN_IDS.includes(id)) {
    // Built-in branch is TERMINAL: a built-in id always wins and never falls
    // through to the user store — a missing/unsafe read returns null rather than
    // letting a same-id user file shadow a built-in.
    if (rest.toLowerCase() === 'target') return null;
    const bytes = readMotifFile(builtinDir, `${id}/${rest}`);
    return bytes ? { bytes, contentType: contentTypeFor(rest) } : null;
  }
  const bytes = store.readFile(id, rest);
  return bytes ? { bytes, contentType: contentTypeFor(rest) } : null;
}
