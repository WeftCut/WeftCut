// A Motif library and project folders in memory, for actors that place
// Motifs without a disk (`ProjectMotifAccess`). The rules it mirrors are
// `ProjectMotifStore.place`'s: a lineage the table holds keeps its id,
// another lineage on the id takes `collisionId`.
import { createHash } from 'node:crypto'
import { BUILTIN_MANIFESTS, builtinLineage, type Manifest } from '../../../../shared/motifs/catalog'
import { collisionId } from '../../../../shared/motifs/projectMotifs'
import type { ProjectMotifAccess } from '../../actor'

const hex = (text: string) => createHash('sha256').update(text).digest('hex')

/** The revision a fake folder named `id` holds. */
export const fakeRevision = (id: string): string => hex(`revision:${id}`)

/** A library holding `manifests` (the built-ins by default). `folders` is
 *  what the project's `Motifs/` holds, by id: a placement writes there, and a
 *  test may too. */
export function libraryMotifs(manifests: Iterable<Manifest> = BUILTIN_MANIFESTS.values()): ProjectMotifAccess & { folders: Map<string, Manifest> } {
  const library = new Map([...manifests].map((m) => [m.id, m]))
  const folders = new Map<string, Manifest>()
  const uidOf = (id: string) => builtinLineage(id) ?? `${hex(id).slice(0, 8)}-0000-4000-8000-${hex(id).slice(8, 20)}`
  return {
    folders,
    manifest: (id) => folders.get(id) ?? null,
    status: (id) => folders.has(id) ? 'ok' : 'missing',
    place(id, table) {
      const m = library.get(id)
      if (!m) return null
      const uid = uidOf(id)
      const held = Object.entries(table).find(([, e]) => e.uid === uid)
      const key = held ? held[0] : Object.hasOwn(table, id) ? collisionId(id, uid) : id
      folders.set(key, { ...m, id: key })
      const entry = held?.[1] ?? { uid, revision: fakeRevision(key), from: { uid, version: m.version, revision: fakeRevision(id) } }
      return { id: key, entry, manifest: folders.get(key)! }
    },
  }
}
