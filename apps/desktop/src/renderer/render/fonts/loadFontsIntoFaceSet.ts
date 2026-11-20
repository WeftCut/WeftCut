// Register raw font bytes into a FontFaceSet so canvas/OffscreenCanvas text
// rasterization can use them. Works on both the main thread (document.fonts)
// and inside a Worker (self.fonts) — FontFace + FontFaceSet.add are available
// in both. MUST be awaited before any PixiJS Text is rasterized, or the first
// frames fall back to another font. Registration belongs to the
// document/Worker, not a Compositor: reopening Preview must not add another
// native copy of every font to document.fonts. Weak keys keep an independent
// font set from being retained by this module.

import { faceAlias } from "../../../shared/fonts/resolve";
import type { FaceRef } from "../../../shared/fonts/types";

const registrations = new WeakMap<FontFaceSet, Map<string, Promise<void>>>();

/// Bundled fonts, registered under their own family names (family → bytes).
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

/// A catalog face to register, and where its bytes come from: IPC on the main
/// thread, the start request in the export Worker. Null bytes = the face is
/// gone.
export interface FaceLoad {
  ref: FaceRef;
  bytes: () => Promise<ArrayBuffer | null>;
}

interface CatalogFace {
  /// Set once the face is loaded and in the set.
  face: FontFace | null;
  /// True when the face is in the set, false when it could not be.
  settled: Promise<boolean>;
}

const catalogFaces = new WeakMap<FontFaceSet, Map<string, CatalogFace>>();

/// The FontFace descriptors of a catalog face: its weight (a variable face's
/// `wght` range as "min max", so the browser sets the axis to the asked
/// weight) and its style.
function faceDescriptors(ref: FaceRef): FontFaceDescriptors {
  const weight = typeof ref.weight === "number" ? String(ref.weight) : `${ref.weight[0]} ${ref.weight[1]}`;
  return { weight, style: ref.italic ? "italic" : "normal" };
}

/// Make the catalog faces registered in `faceSet` exactly `faces`: each one
/// missing is added under `faceAlias(sha256)` with `faceDescriptors`, each one
/// no longer listed is deleted. Resolves once every listed face is in the set
/// or has failed, with the hashes that failed (bytes gone, font rejected); a
/// failed face is retried by the next call. Never rejects for one face: a
/// family whose face failed is skipped by the font stack in preview and
/// export alike.
export async function syncFaces(faceSet: FontFaceSet, faces: readonly FaceLoad[]): Promise<string[]> {
  let registered = catalogFaces.get(faceSet);
  if (!registered) {
    registered = new Map();
    catalogFaces.set(faceSet, registered);
  }
  const entries = registered;
  const wanted = new Set(faces.map(f => f.ref.sha256));
  for (const [sha, entry] of entries) {
    if (wanted.has(sha)) continue;
    entries.delete(sha);
    // One still loading is never added: it checks its slot first.
    if (entry.face) faceSet.delete(entry.face);
  }
  const results = await Promise.all(
    faces.map(async ({ ref, bytes }) => {
      let entry = entries.get(ref.sha256);
      if (!entry) {
        const slot: CatalogFace = { face: null, settled: Promise.resolve(false) };
        slot.settled = (async () => {
          try {
            const data = await bytes();
            if (!data) return false;
            const face = new FontFace(faceAlias(ref.sha256), data, faceDescriptors(ref));
            await face.load();
            if (entries.get(ref.sha256) !== slot) return false;
            faceSet.add(face);
            slot.face = face;
            return true;
          } catch {
            return false;
          }
        })().then(ok => {
          if (!ok && entries.get(ref.sha256) === slot) entries.delete(ref.sha256);
          return ok;
        });
        entries.set(ref.sha256, slot);
        entry = slot;
      }
      return (await entry.settled) ? null : ref.sha256;
    }),
  );
  return results.filter((sha): sha is string => sha !== null);
}

/// True when every face in `refs` is already in `faceSet`: a sync would add
/// nothing.
export function hasFaces(faceSet: FontFaceSet, refs: readonly FaceRef[]): boolean {
  const entries = catalogFaces.get(faceSet);
  return refs.every(ref => entries?.get(ref.sha256)?.face != null);
}
