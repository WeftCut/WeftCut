// The open project's Motifs as rendering reads them: every layer's `motif_id`
// resolves here and nowhere else (the project folder holds what it renders,
// spec § Project Motifs). Library Motifs are not in it; the Motifs panel
// fetches them apart. Types and frame math live in the shared module; this
// file adds the React `useSyncExternalStore` subscription layer.
//
// Filled by `syncCatalog.ts`; plan: docs/motifs.md

import {
  type PropSpec,
  type Manifest,
  canonicalizePropsLenient as _sharedLenient,
  resolveMotifContentDurationUs,
} from "../../../shared/motifs/catalog";
import type { UnavailableMotif } from "../../../shared/motifs/projectMotifs";

// Re-export shared types/functions so consumers see a stable surface.
export type { PropSpec };
export { resolveMotifContentDurationUs };

/// Renderer alias — keeps all consumers compiling without change.
export type MotifManifest = Manifest;

export interface Motif {
  manifest: MotifManifest;
  /// The Motif ships its own parameter page (`params.html`). Stamped by the
  /// backend catalog payload — only the main process can stat the file.
  hasParamsUi: boolean;
}

// ---------------------------------------------------------------------------
// Catalog state
// ---------------------------------------------------------------------------

let renderable: ReadonlyMap<string, Motif> = new Map();
let unavailable: ReadonlyMap<string, UnavailableMotif> = new Map();

let catalogRevision = 0;
const catalogSubscribers = new Set<() => void>();

/// Subscribe to catalog changes (a `setProjectMotifs` call). Returns an unsubscribe fn.
/// Pair with `motifCatalogRevision` for React's `useSyncExternalStore`.
export function subscribeMotifCatalog(cb: () => void): () => void {
  catalogSubscribers.add(cb);
  return () => catalogSubscribers.delete(cb);
}

/// A monotonically increasing revision, bumped on every `setProjectMotifs`. The
/// `getSnapshot` for `useSyncExternalStore`.
export function motifCatalogRevision(): number {
  return catalogRevision;
}

/// Replaces the catalog with the open project's Motifs: `manifests` those
/// that render, `missing` those whose folder is gone or makes no package.
/// Idempotent — call it whenever the backend catalog changes, and with no
/// arguments when no project is open.
export function setProjectMotifs(manifests: MotifManifest[] = [], missing: UnavailableMotif[] = []): void {
  renderable = new Map(manifests.map((m) => [m.id, { manifest: m, hasParamsUi: m.has_params_ui === true }]));
  unavailable = new Map(missing.map((m) => [m.motif_id, m]));
  catalogRevision += 1;
  for (const cb of catalogSubscribers) cb();
}

/// The project Motif `id`, or null when the project holds none that renders.
export function getMotif(id: string): Motif | null {
  return renderable.get(id) ?? null;
}

/// Why project Motif `id` cannot render, when the project records it but its
/// folder is missing or invalid; null for one that renders or one the catalog
/// has not heard of yet (a sync still in flight).
export function motifUnavailable(id: string): UnavailableMotif | null {
  return unavailable.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Adapters — keep (props, manifest) call signature so all consumers compile
// unchanged; delegate to the shared (manifest, props) functions.
// ---------------------------------------------------------------------------

/// Render-path prop canonicalizer that NEVER throws — drops unknown keys, fills
/// missing keys from defaults, and falls back to the default when a value fails
/// its spec. The strict `canonicalizeProps` (Rasterizer) stays on the
/// ADD/validation path; the render path uses this so a layer whose Motif's
/// `props_schema` changed under it (an in-place update) degrades gracefully
/// instead of rendering blank.
///
/// NOTE: argument order is (props, manifest) — intentionally opposite of the
/// shared function — to preserve the existing call sites unchanged.
export function canonicalizePropsLenient(
  props: Record<string, unknown>,
  manifest: MotifManifest,
): Record<string, unknown> {
  return _sharedLenient(manifest, props);
}
