// Reading the project's Motif table ops' arguments, and which layers use an
// entry. The table's rules are `validate.ts`'s; the folders are
// `main/motif/projectStore.ts`'s.
import type { ProjectMotifSource } from '../../../shared/motifs/projectMotifs'
import { CommandFailure } from '../errors'
import { eachLayer, type Project, type Uuid } from '../model'

const REVISION = /^[0-9a-f]{64}$/

const invalid = (field: string, detail: string): never => { throw new CommandFailure({ error: 'InvalidArgument', field, detail }) }

/** A package revision: the SHA-256 of its files, lowercase hex. */
export function parseRevision(v: unknown, field: string): string {
  if (typeof v !== 'string' || !REVISION.test(v)) invalid(field, `${field} must be a Motif revision: 64 lowercase hex digits`)
  return v as string
}

/** An entry's library source, or null for a Motif made in the project. */
export function parseMotifSource(v: unknown, field: string): ProjectMotifSource | null {
  if (v === null) return null
  const o = v as Partial<ProjectMotifSource> | undefined
  if (typeof o !== 'object' || typeof o.uid !== 'string' || !Number.isSafeInteger(o.version) || (o.version as number) < 1)
    invalid(field, `${field} must be null or { uid, version, revision }`)
  return { uid: o!.uid!, version: o!.version!, revision: parseRevision(o!.revision, `${field}.revision`) }
}

/** The layers of any composition that render Motif `id`. */
export function motifUsers(p: Project, id: string): Uuid[] {
  const out: Uuid[] = []
  for (const { layer } of eachLayer(p)) if (layer.params.kind === 'Motif' && layer.params.motif_id === id) out.push(layer.id)
  return out
}
