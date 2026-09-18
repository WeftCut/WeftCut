// apps/desktop/src/main/mcp/hybridResult.ts
//
// The MCP-side shape of a hybrid tool's answer. `runHybrid` keeps its STRING
// contract — the renderer's IPC wrappers parse it (`renderer/ipc/index.ts`) —
// and this reads the committed record back for the agent, so the two surfaces
// share the write and differ only in how they report it. `before`/`after`
// are the actor snapshots around the call: the caption count they differ by
// is what a subtitle import added.
import type { Project } from '../state/model.js'
import { toolText, type ToolResultJson } from '../state/mcp-commands.js'
import { captionCueCount, mediaRecord, toolRecord } from '../state/mcp-results.js'

const SUBTITLE_EXT = /\.(srt|ass|vtt)$/i

export function shapeHybridResult(name: string, args: Record<string, unknown>, result: unknown, before: Project, after: Project): ToolResultJson {
  const text = String(result)
  switch (name) {
    case 'import_media': {
      // A subtitle document is CONSUMED into a caption track, not pooled: the
      // id that comes back is a track's, and the record says so.
      if (SUBTITLE_EXT.test(String(args.path ?? '')))
        return toolRecord({ caption_track_id: text, cues: captionCueCount(after) - captionCueCount(before) })
      return toolRecord(mediaRecord(after, text) ?? { media_id: text })
    }
    case 'apply_subtitles': {
      // `<track id>` or `<track id> (some ASS styling was simplified)`.
      const id = text.split(' ')[0] ?? text
      return toolRecord({ caption_track_id: id, cues: captionCueCount(after) - captionCueCount(before), simplified: text.includes('simplified') })
    }
    default: {
      // synthesize_speech / auto_split_by_shot / remove_pauses answer a JSON
      // object as a string; anything else stays the text it was.
      try {
        const v = JSON.parse(text) as unknown
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) return toolRecord(v as Record<string, unknown>)
      } catch { /* not JSON */ }
      return toolText(text)
    }
  }
}
