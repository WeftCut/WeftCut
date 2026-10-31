// apps/desktop/src/main/mcp/hybridResult.ts
//
// The MCP-side shape of a hybrid tool's answer. `import_media` answers the
// import module's explicit outcome over the committed record; the other hybrid
// tools retain their serialized-result contract.
import type { ImportOutcome } from '../state/mediaImport'
import type { Project } from '../state/model.js'
import { toolText, type ToolResultJson } from '../state/mcp-commands.js'
import { mediaRecord, toolRecord } from '../state/mcp-results.js'

export function shapeHybridResult(result: unknown): ToolResultJson {
  const text = String(result)
  // apply_subtitles / synthesize_speech / auto_split_by_shot / remove_pauses
  // answer a JSON object as a string; anything else stays the text it was.
  try {
    const v = JSON.parse(text) as unknown
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return toolRecord(v as Record<string, unknown>)
  } catch { /* not JSON */ }
  return toolText(text)
}

/** An import's record, saying when the pool already held the file
 *  (`existing`), when that item was pointed at this file because its own was
 *  gone (`relinked`), or when it holds its bytes under another path
 *  (`same_content_as`). `path` / `path_rel` name the pooled file: under
 *  `Media/` once the project holds its copy, and while that copy still runs,
 *  the place it lands, with `copying: true` (the source is read until then).
 *  `after` is the snapshot once the call has committed. */
export function shapeImportResult(outcome: ImportOutcome, after: Project): ToolResultJson {
  const record = mediaRecord(after, outcome.mediaId)
  if (!record) return toolRecord({ media_id: outcome.mediaId })
  const pooled = outcome.copying
    ? { path: outcome.copying.path_abs, path_rel: outcome.copying.path_rel, copying: true }
    : { path_rel: after.media_pool[outcome.mediaId]!.path_rel }
  const relinked = outcome.disposition === 'relinked' ? { relinked: true } : {}
  if (outcome.existing) return toolRecord({ ...record, ...pooled, existing: true, ...relinked })
  return toolRecord(outcome.sameContentAs.length > 0 ? { ...record, ...pooled, same_content_as: outcome.sameContentAs, ...relinked } : { ...record, ...pooled, ...relinked })
}
