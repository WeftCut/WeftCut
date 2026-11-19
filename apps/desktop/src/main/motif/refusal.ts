// apps/desktop/src/main/motif/refusal.ts
//
// A Motif store refusal that carries its variant and data: a revision
// conflict names the current revision, a taken id names its holder and the
// two ways forward. The renderer reads the message; the MCP error mapper
// (`mcp/toolResult.ts` `thrownToToolError`) keeps the data.

export interface MotifRefusalData { error: string; [key: string]: unknown }

export class MotifRefusal extends Error {
  constructor(message: string, readonly data: MotifRefusalData, readonly code: 'invalid_params' | 'invalid_request' = 'invalid_params') {
    super(message)
    this.name = 'MotifRefusal'
  }
}

/** A stale `expected_revision`: the answer carries the one the caller needs,
 *  null for a folder whose files make no package. */
export function revisionConflict(currentRevision: string | null, next: string): MotifRefusal {
  const current = currentRevision === null ? "the Motif's files make no package, so it has no revision" : `the current revision is ${currentRevision}`
  return new MotifRefusal(`Motif revision conflict: ${current}; ${next}`, { error: 'RevisionConflict', current_revision: currentRevision })
}

/** A folder `Motifs/<folder>/` whose name differs from Motif `id`'s only in
 *  case, where `id`'s folder is to be written. */
export function caseAliasRefusal(folder: string, id: string): MotifRefusal {
  return new MotifRefusal(`Motifs/${folder} differs only in case from ${id}; rename it to ${id}, or move it out of Motifs/`, { error: 'MotifFolderCaseAlias', id, folder })
}
