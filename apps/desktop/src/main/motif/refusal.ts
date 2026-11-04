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

/** A stale `expected_revision`: the answer carries the one the caller needs. */
export function revisionConflict(currentRevision: string, next: string): MotifRefusal {
  return new MotifRefusal(`Motif revision conflict: the current revision is ${currentRevision}; ${next}`, { error: 'RevisionConflict', current_revision: currentRevision })
}
