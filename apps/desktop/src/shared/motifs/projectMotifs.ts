// The project's Motif table and the `motif://` hosts that name a Motif's
// scope. The table's rules live with its readers: `main/motif/projectStore.ts`
// owns the folders it describes, `main/state/migrate.ts` builds it for older
// projects. See the portable-project spec, § Project Motifs.

/** The library package a project Motif was copied from: its lineage, the
 *  manifest version and the revision copied. */
export interface ProjectMotifSource { uid: string; version: number; revision: string }

/** One Motif the project renders, kept in `Motifs/<id>/`. `revision` is the
 *  revision the project last recorded for its folder, null when no folder was
 *  ever made for it; `from` is null for a Motif made in a project. */
export interface ProjectMotifEntry { uid: string; revision: string | null; from: ProjectMotifSource | null }

/** Keyed by id, which is also the entry's folder name under `Motifs/`. */
export type ProjectMotifs = Record<string, ProjectMotifEntry>

/** Whether a project Motif can render: `missing` when its folder is gone,
 *  `invalid` when its files make no package. Derived from the folder, never
 *  stored. */
export type MotifStatus = 'ok' | 'missing' | 'invalid'

/** A project Motif that cannot render, and why: what `project://session`
 *  lists and an export refuses. */
export interface UnavailableMotif { motif_id: string; status: Exclude<MotifStatus, 'ok'>; diagnostic: string }

/** A Motif's id is the label of its `motif://` host. */
export const MOTIF_HOST_LABEL_CHARS = 63

/** Whether the app may give a new Motif `id`: one lowercase host label of
 *  ASCII letters, digits and single dashes that is no Windows device name,
 *  as `idFromName` makes them. Ids a project already holds are read whatever
 *  their form. */
export function isNewMotifId(id: string): boolean {
  return id.length <= MOTIF_HOST_LABEL_CHARS && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)
}

/** Whether `id` can key the project's Motif table: a folder name under
 *  `Motifs/` on every system and the `motif://` host that serves it. URL
 *  parsing lowercases a host and `--` marks the library and proposal hosts,
 *  so a key holds neither. */
export function isProjectMotifKey(id: string): boolean {
  return id.length <= MOTIF_HOST_LABEL_CHARS && /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(id)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)
}

/** A host names a project Motif by its bare id; the other scopes add a
 *  suffix. `idFromName` never emits `--`, so no id can take either form. */
const LIBRARY_SUFFIX = '--library'
const PROPOSAL_SUFFIX = '--proposal'

/** The host serving library Motif `id`. */
export function libraryHost(id: string): string { return id + LIBRARY_SUFFIX }
/** The library id `host` names, or null when it names no library Motif. */
export function libraryIdOfHost(host: string): string | null {
  return host.endsWith(LIBRARY_SUFFIX) ? host.slice(0, -LIBRARY_SUFFIX.length) : null
}

/** The host a pending publication's frozen package is served and captured
 *  under. */
export function proposalPreviewId(key: string): string { return key + PROPOSAL_SUFFIX }
export function isProposalPreviewId(host: string): boolean { return host.endsWith(PROPOSAL_SUFFIX) }
/** The key `proposalPreviewId` was given, or null for any other host. */
export function proposalOfHost(host: string): string | null {
  return isProposalPreviewId(host) ? host.slice(0, -PROPOSAL_SUFFIX.length) : null
}

/** Hex digits of the lineage in a collision id. */
const COLLISION_DIGITS = 8

/** The id an automatic copy takes when `id` is held by another lineage:
 *  `<id>-<first 8 hex of uid>`. The id is shortened to keep the result one
 *  host label. */
export function collisionId(id: string, uid: string): string {
  const suffix = '-' + uid.replace(/-/g, '').slice(0, COLLISION_DIGITS).toLowerCase()
  const base = id.slice(0, MOTIF_HOST_LABEL_CHARS - suffix.length).replace(/-+$/, '')
  return base + suffix
}
