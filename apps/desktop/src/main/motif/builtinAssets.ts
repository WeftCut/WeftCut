import path from "node:path";
import { app } from "electron";

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
