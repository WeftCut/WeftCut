/** Versioned, optional Layer.metadata entry. Times are relative to the caption,
 * so a plain move preserves them; edits that cannot preserve the mapping abstain. */
export interface CaptionWord { text: string; start_us: number; end_us: number }
export interface CaptionTiming {
  version: 1
  text: string
  duration_us: number
  provenance: 'exact' | 'interpolated_from_cue' | 'none'
  words: CaptionWord[]
  source?: { id: string; signature: string }
}
export const CAPTION_TIMING_KEY = 'weftcut.caption_timing'

export interface TranscriptPayload {
  source?: { id: string; signature: string; project_id: string; composition_id: string }
  word_timing: 'exact' | 'interpolated_from_cue' | 'none'
  segments: Array<{ text: string; t_start_us: number; t_end_us: number; words: Array<{ text: string; t_start_us: number; t_end_us: number }> }>
}

export function readCaptionTiming(value: unknown): CaptionTiming | null {
  if (!value || typeof value !== 'object') return null
  const v = value as CaptionTiming
  if (v.version !== 1 || typeof v.text !== 'string' || !Number.isSafeInteger(v.duration_us) || v.duration_us <= 0 || !['exact', 'interpolated_from_cue', 'none'].includes(v.provenance) || !Array.isArray(v.words)) return null
  let previous = 0
  for (const w of v.words) {
    if (!w || typeof w.text !== 'string' || !w.text.trim() || !Number.isSafeInteger(w.start_us) || !Number.isSafeInteger(w.end_us) || w.start_us < previous || w.end_us < w.start_us || w.end_us > v.duration_us + 50_000) return null
    previous = w.end_us
  }
  if (v.source && (typeof v.source.id !== 'string' || typeof v.source.signature !== 'string')) return null
  return v
}
