// apps/desktop/src/shared/subtitleFormat.ts
// SRT and WebVTT bodies from cue spans — `export_captions`' output. The read
// half of the subtitle pair (`apply_subtitles` parses these formats in Rust);
// pure text, no state, so both processes may use it.

export interface FormatCue { start_us: number; end_us: number; text: string }

/** `HH:MM:SS` + `sep` + `mmm`, from microseconds rounded to the millisecond —
 *  the finest either format can carry. */
function stamp(us: number, sep: ',' | '.'): string {
  const ms = Math.round(us / 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const frac = ms % 1000
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(h)}:${two(m)}:${two(s)}${sep}${String(frac).padStart(3, '0')}`
}

/** A cue's text as a block payload: CRLF folded to LF and blank lines dropped,
 *  since a blank line ENDS a cue block in both formats and would hand the rest
 *  of the text to the reader as the next cue. WebVTT payload text is markup, so
 *  `&`, `<` and `>` are escaped there; SRT has no escaping convention and its
 *  tags are meant literally. */
function payload(text: string, vtt: boolean): string {
  const body = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '').join('\n')
  return vtt ? body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : body
}

/** Cues in time order, each numbered from 1. An empty list is an empty body. */
export function formatSrt(cues: readonly FormatCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start_us, ',')} --> ${stamp(c.end_us, ',')}\n${payload(c.text, false)}\n`).join('\n')
}

/** The `WEBVTT` header, then the cues; VTT cues carry no numbers. */
export function formatVtt(cues: readonly FormatCue[]): string {
  const body = cues.map((c) => `${stamp(c.start_us, '.')} --> ${stamp(c.end_us, '.')}\n${payload(c.text, true)}\n`).join('\n')
  return `WEBVTT\n\n${body}`
}
