// apps/desktop/src/main/motif/authoring.ts
//
// The built-ins, the library's catalog payload and the props rebind of a new
// Motif version (TS-owned outright — no Rust counterpart exists). Pure: no
// actor, no IPC, no event emit — the host dispatcher (motifTools.ts) wraps
// these with the store/actor/emit.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BUILTIN_IDS, BUILTIN_MANIFESTS, PARAMS_PAGE_FILE, type Manifest,
  parseManifestIsland, canonicalizePropsLenient,
} from '../../shared/motifs/catalog'
import type { MotifRebindEntry } from '../state/model'
import { motifContentHash } from './contentHash'
import type { UserMotifStore } from './store'
import { readMotifDirectory, type MotifFile } from './packageFiles'

export interface BuiltinMotif { id: string; manifest: Manifest; html: string; hasParamsUi: boolean; files?: MotifFile[] }

/** Load each built-in's {id, manifest, html}. Manifest comes from the bundled
 *  BUILTIN_MANIFESTS (authoritative); html is read from `<builtinDir>/<id>/index.html`
 *  (the served assets). `builtinDir` is passed explicitly
 *  (host computes via builtinAssetDir(); tests pass a fixture dir) so this is
 *  hermetic. A built-in whose html can't be read is skipped (defensive).
 *  `hasParamsUi` is stat'd from the same directory — built-in assets are
 *  packaged read-only, so the boot-time answer holds for the process. */
export function builtinMotifs(builtinDir: string): BuiltinMotif[] {
  const out: BuiltinMotif[] = []
  for (const id of BUILTIN_IDS) {
    const manifest = BUILTIN_MANIFESTS.get(id)
    if (!manifest) continue
    let html: string
    try { html = readFileSync(path.join(builtinDir, id, 'index.html'), 'utf8') } catch { continue }
    const hasParamsUi = existsSync(path.join(builtinDir, id, PARAMS_PAGE_FILE))
    out.push({ id, manifest, html, hasParamsUi, files: readMotifDirectory(path.join(builtinDir, id)) })
  }
  return out
}

/** Serialize manifest + raw html into the picker payload (superset of MCP
 *  list_motifs: every manifest field + html + status + content_hash). One helper
 *  so library and project rows emit the same shape. `html` MUST be the
 *  composed/stored FULL html (island included) — content_hash is computed over it.
 *  `hasParamsUi` is presence of the optional `params.html` companion; it rides
 *  the payload as `has_params_ui`. `contentHash` is the package's revision:
 *  every companion's bytes enter it, because render scripts may read any
 *  package resource (including shared UI assets). */
export function motifToPayload(
  manifest: Manifest,
  html: string,
  status: string,
  contentHash: string,
  hasParamsUi = false,
): Record<string, unknown> {
  return { ...manifest, html, status, content_hash: contentHash, has_params_ui: hasParamsUi }
}

/** Built-in assets are packaged read-only, so a loaded built-in's revision
 *  holds for the process. */
const builtinRevisions = new WeakMap<BuiltinMotif, string>()
function builtinRevision(b: BuiltinMotif): string {
  let revision = builtinRevisions.get(b)
  if (revision === undefined) {
    revision = motifContentHash(b.manifest, b.html, b.files ?? [])
    builtinRevisions.set(b, revision)
  }
  return revision
}

/** The revision of a library Motif's package, a built-in's included; an
 *  installed package's bytes are read only when they changed since it was
 *  recorded. */
export function motifRevision(store: UserMotifStore, builtins: BuiltinMotif[], id: string): string {
  const builtin = builtins.find(b => b.id === id)
  if (builtin) return builtinRevision(builtin)
  const pkg = store.installedListing(id)
  if (!pkg) throw new Error(`unknown motif id '${id}'`)
  return pkg.revision
}

/** One listing supplies HTML, revision and UI presence. A partial external
 * save or invalid package must not make every other Motif disappear. */
function installedPayload(store: UserMotifStore, id: string): Record<string, unknown> | null {
  try {
    const pkg = store.installedListing(id)
    if (!pkg) return null
    return motifToPayload(parseManifestIsland(pkg.html), pkg.html, 'installed', pkg.revision, pkg.paths.includes(PARAMS_PAGE_FILE))
  } catch { return null }
}

/** The library's catalog: built-ins, then installed Motifs. Params-page
 *  presence is re-stat'd per call, so the watcher's catalog refresh is all it
 *  takes for a hand-authored `params.html` to appear or vanish. */
export function listMotifsInner(store: UserMotifStore, builtins: BuiltinMotif[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const b of builtins) out.push(motifToPayload(b.manifest, b.html, 'builtin', builtinRevision(b), b.hasParamsUi))
  for (const manifest of store.listManifests()) {
    const entry = installedPayload(store, manifest.id)
    if (entry) out.push(entry)
  }
  return out
}

export interface MotifLayerRef { layerId: string; motifId: string; props: Record<string, unknown> }

/** Per-layer rebind updates for a new version of a Motif: every layer whose
 *  motif_id is `workingId` OR the target's id ends up on the target's id,
 *  with props lenient-migrated to the new schema (drop unknown, fill new
 *  defaults, fall back invalid values). Pure. */
export function buildRebindUpdates(layers: MotifLayerRef[], workingId: string, target: Manifest): MotifRebindEntry[] {
  const updates: MotifRebindEntry[] = []
  for (const l of layers) {
    if (l.motifId !== workingId && l.motifId !== target.id) continue
    updates.push({
      layer_id: l.layerId,
      motif_id: target.id,
      props: canonicalizePropsLenient(target, l.props),
    })
  }
  return updates
}
