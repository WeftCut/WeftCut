import { createHash } from "node:crypto";
import { coreManifestForHash, type Manifest } from "../../shared/motifs/catalog";
import type { MotifFile } from './packageFiles';

/**
 * sha256 of canonical manifest, HTML and sorted length-framed companion files.
 * Empty packages preserve the original manifest/HTML hash.
 * Feeds the capture host `?v=` cache-buster + raster key.
 */
export function motifContentHash(manifest: Manifest, html: string, files: readonly MotifFile[] = []): string {
  const hasher = createHash("sha256");
  // Compact (no whitespace) canonical JSON of the CORE fields only.
  const manifestJson = JSON.stringify(coreManifestForHash(manifest));
  hasher.update(Buffer.from(manifestJson, "utf8"));
  hasher.update(Buffer.from([0]));
  hasher.update(Buffer.from(html, "utf8"));
  hasher.update(Buffer.from([0]));
  // Length-framed paths + bytes: edits, additions, removals and renames all
  // invalidate captures. index.html is already hashed above; target is private.
  for (const file of [...files].filter(f => f.path !== 'index.html' && f.path.toLowerCase() !== 'target')
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    hasher.update(JSON.stringify([file.path, file.bytes.length]));
    hasher.update(file.bytes);
  }
  return hasher.digest("hex");
}
