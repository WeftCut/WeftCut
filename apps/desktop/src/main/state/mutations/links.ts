// apps/desktop/src/main/state/mutations/links.ts
import type { Link, Project, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { locateLayer, rootComposition } from './helpers'

/** link.rs:index_links — member LayerId → owning LinkId. */
export function indexLinks(links: Link[]): Map<Uuid, Uuid> {
  const m = new Map<Uuid, Uuid>()
  for (const g of links) for (const member of g.members) m.set(member, g.id)
  return m
}

/** Every layer id across all tracks. */
export function layerIdSet(p: Project): Set<Uuid> {
  const c = rootComposition(p)
  const s = new Set<Uuid>()
  for (const t of c.tracks) for (const l of t.layers) s.add(l.id)
  return s
}

/** All OTHER members of `id`'s link, in sorted member
 *  order (Rust OrdSet iteration order). Empty when unlinked. The sort is the
 *  id-allocation-order guarantee for split fan-out. */
export function linkSiblingsExcluding(p: Project, id: Uuid): Uuid[] {
  const c = rootComposition(p)
  const idx = indexLinks(c.links)
  const gid = idx.get(id)
  if (gid === undefined) return []
  const link = c.links.find((g) => g.id === gid)
  if (!link) return []
  return [...link.members].filter((m) => m !== id).sort()
}

/** Reject if any `touched` member is layer-locked or on a
 *  locked track. No-op when `anchor` is unlinked. */
export function checkLinkLock(p: Project, anchor: Uuid, touched: Iterable<Uuid>): void {
  const c = rootComposition(p)
  const idx = indexLinks(c.links)
  const gid = idx.get(anchor)
  if (gid === undefined) return
  for (const id of touched) {
    const loc = locateLayer(p, id)
    if (!loc) continue
    const track = c.tracks[loc[0]]
    if (track.locked) throw new CommandFailure({ error: 'TrackLocked', track: track.id })
    const layer = track.layers[loc[1]]
    if (layer.locked) throw new CommandFailure({ error: 'LinkLockedMember', link: gid, locked_layer: id, touched: anchor })
  }
}

// ── Write-side link mutations ────────────────────────────────────────────────

import type { IdGen } from '../ids'
import { dropLayerFromLinks } from './helpers'

function sortedUnique(ids: Uuid[]): Uuid[] { return [...new Set(ids)].sort() }

/** Create a new link from the given layer ids.
 *  Dedup → existence → already-linked → reassign-drops → id alloc → push.
 *  `label === null` → field omitted (serde None parity: `'label' in link === false`). */
export function applyLinksCreate(p: Project, idGen: IdGen, layerIds: Uuid[], label: string | null, reassign: boolean): Uuid {
  const c = rootComposition(p)
  const unique = sortedUnique(layerIds)
  if (unique.length < 2) throw new CommandFailure({ error: 'LinkCreateNeedsTwoLayers', got: unique.length })
  const known = layerIdSet(p)
  for (const m of unique) if (!known.has(m)) throw new CommandFailure({ error: 'LayerNotFound', layer: m })
  const idx = indexLinks(c.links)
  for (const m of unique) {
    const existing = idx.get(m)
    if (existing !== undefined && !reassign) throw new CommandFailure({ error: 'LayerAlreadyLinked', layer: m, existing })
  }
  if (reassign) for (const m of unique) dropLayerFromLinks(c, m)
  const id = idGen()
  const link: Link = label === null ? { id, members: unique } : { id, label, members: unique }
  c.links.push(link)
  return id
}

export function applyLinksDissolve(p: Project, id: Uuid): void {
  const c = rootComposition(p)
  const i = c.links.findIndex((g) => g.id === id)
  if (i < 0) throw new CommandFailure({ error: 'LinkNotFound', link: id })
  c.links.splice(i, 1)
}

/** Add members to an existing link.
 *  layer-existence → already-linked scan → reassign-drops → LinkNotFound → insert sorted.
 *  Order matches Rust exactly: already-linked check runs before the target-link lookup. */
export function applyLinksAddMembers(p: Project, id: Uuid, layerIds: Uuid[], reassign: boolean): void {
  const c = rootComposition(p)
  // Scan the RAW input (Rust iterates layer_ids unmodified — first error follows input order).
  const known = layerIdSet(p)
  for (const m of layerIds) if (!known.has(m)) throw new CommandFailure({ error: 'LayerNotFound', layer: m })
  const idx = indexLinks(c.links)
  for (const m of layerIds) {
    const existing = idx.get(m)
    if (existing !== undefined && existing !== id && !reassign) throw new CommandFailure({ error: 'LayerAlreadyLinked', layer: m, existing })
  }
  if (reassign) for (const m of layerIds) { if (idx.get(m) !== id) dropLayerFromLinks(c, m) }
  // LinkNotFound is checked AFTER the scans.
  const target = c.links.find((g) => g.id === id)
  if (!target) throw new CommandFailure({ error: 'LinkNotFound', link: id })
  // Final member set is an OrdSet: dedup + sort (mirrors link.members.insert).
  target.members = [...new Set([...target.members, ...layerIds])].sort()
}

/** Remove members; auto-dissolve below 2. */
export function applyLinksRemoveMembers(p: Project, id: Uuid, layerIds: Uuid[]): void {
  const c = rootComposition(p)
  const i = c.links.findIndex((g) => g.id === id)
  if (i < 0) throw new CommandFailure({ error: 'LinkNotFound', link: id })
  const g = c.links[i]
  const members = new Set(g.members)
  for (const m of layerIds) if (!members.has(m)) throw new CommandFailure({ error: 'LayerNotInLink', link: id, layer: m })
  const removals = new Set(layerIds)
  g.members = g.members.filter((m) => !removals.has(m))
  if (g.members.length < 2) c.links.splice(i, 1)
}

/** Rename a link; null → delete label field (serde None parity). */
export function applyLinksRename(p: Project, id: Uuid, label: string | null): void {
  const c = rootComposition(p)
  const g = c.links.find((x) => x.id === id)
  if (!g) throw new CommandFailure({ error: 'LinkNotFound', link: id })
  if (label === null) delete g.label
  else g.label = label
}
