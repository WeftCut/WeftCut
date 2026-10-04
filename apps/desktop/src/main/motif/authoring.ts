// apps/desktop/src/main/motif/authoring.ts
//
// The Motif authoring lifecycle + catalog payload (TS-owned outright — no
// Rust counterpart exists). Pure: no actor, no IPC, no event emit — the host
// dispatcher (motifTools.ts) wraps these with the store/actor/emit.
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
export interface MotifSourceTs { manifest: Manifest; html: string }

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

/** Read any built-in or user Motif's source. Built-ins win. */
export function getMotifSource(store: UserMotifStore, builtins: BuiltinMotif[], id: string): MotifSourceTs {
  const b = builtins.find((x) => x.id === id)
  if (b) return { manifest: b.manifest, html: b.html }
  const m = store.getMotif(id)
  if (m) return { manifest: m.manifest, html: m.html }
  throw new Error(`unknown motif id '${id}'`)
}

/** Serialize manifest + raw html into the picker payload (superset of MCP
 *  list_motifs: every manifest field + html + status + content_hash). One helper
 *  so built-in/installed/draft emit the same shape. `html` MUST be the
 *  composed/stored FULL html (island included) — content_hash is computed over it.
 *  `hasParamsUi` is presence of the optional `params.html` companion; it rides
 *  the payload as `has_params_ui`. All companion bytes enter the hash because
 *  render scripts may read any package resource (including shared UI assets). */
export function motifToPayload(
  manifest: Manifest,
  html: string,
  status: string,
  hasParamsUi = false,
  files: readonly MotifFile[] = [],
): Record<string, unknown> {
  const content_hash = motifContentHash(manifest, html, files)
  return { ...manifest, html, status, content_hash, has_params_ui: hasParamsUi }
}

/** One snapshot supplies HTML, resources and UI presence. A partial external
 * save or invalid package must not make every other Motif disappear. */
function userMotifPayload(store: UserMotifStore, id: string, status: string): Record<string, unknown> | null {
  try {
    const files = store.packageFiles(id)
    const html = files.find(f => f.path === 'index.html')?.bytes.toString('utf8')
    if (html === undefined) return null
    return motifToPayload(parseManifestIsland(html), html, status,
      files.some(f => f.path === PARAMS_PAGE_FILE), files)
  } catch { return null }
}

/** UI catalog: builtins, then installed, then drafts (id-unique; a draft whose id
 *  is already published/built-in is skipped — published wins).
 *  A draft with a recorded Update target carries `target_id`.
 *  Params-page presence is re-stat'd per call (published-then-draft for user
 *  Motifs, mirroring `store.readFile`), so the watcher's catalog refresh is all
 *  it takes for a hand-authored `params.html` to appear or vanish. */
export function listMotifsInner(store: UserMotifStore, builtins: BuiltinMotif[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const b of builtins) out.push(motifToPayload(b.manifest, b.html, 'builtin', b.hasParamsUi, b.files))
  for (const manifest of store.listManifests()) {
    const entry = userMotifPayload(store, manifest.id, 'installed')
    if (entry) out.push(entry)
  }
  const seen = new Set(out.map((e) => e.id as string))
  for (const draft of store.listDrafts()) {
    const draftId = draft.manifest.id
    if (seen.has(draftId)) continue
    const entry = userMotifPayload(store, draftId, 'draft')
    if (!entry) continue
    const target = store.readDraftTarget(draftId)
    if (target) entry.target_id = target
    out.push(entry)
  }
  return out
}

/** Binary assets stay on disk, never in the catalog/IPC payload. */
export function motifSourceFiles(store: UserMotifStore, builtins: BuiltinMotif[], id: string): MotifFile[] {
  const builtin = builtins.find(b => b.id === id)
  return builtin ? builtin.files ?? [] : store.packageFiles(id)
}

export interface MotifLayerRef { layerId: string; motifId: string; version: number; props: Record<string, unknown> }

/** Per-layer rebind updates for an Update: every layer whose motif_id is the
 *  working draft id OR the target id ends up on the target id, at the new version,
 *  with props lenient-migrated to the new schema (drop unknown, fill new defaults,
 *  fall back invalid values). Pure. */
export function buildRebindUpdates(layers: MotifLayerRef[], workingId: string, target: Manifest): MotifRebindEntry[] {
  const updates: MotifRebindEntry[] = []
  for (const l of layers) {
    if (l.motifId !== workingId && l.motifId !== target.id) continue
    updates.push({
      layer_id: l.layerId,
      motif_id: target.id,
      motif_version: target.version,
      props: canonicalizePropsLenient(target, l.props),
    })
  }
  return updates
}
