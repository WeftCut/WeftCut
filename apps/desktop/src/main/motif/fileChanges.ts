// What an `update_motif_files` batch asks of a Motif's files: each entry
// replaces a file (text or inline base64), edits one by exact-match
// replacement, or deletes it. Pure: the project store writes the result.
import { motifFileSegments, type MotifFile } from './packageFiles'

/** An exact-match replacement inside one UTF-8 file: `old` must occur exactly once. */
export interface TextEdit {
  old: string
  new: string
}
export interface FileChange {
  path: string
  text?: string
  /** Canonical base64 of the whole file: the one inline form for binary bytes. */
  base64?: string
  delete?: boolean
  edits?: TextEdit[]
}
/** The inline binary form's bounds: one entry, and one call's entries together. */
export const INLINE_FILE_BYTES = 256 * 1024
export const INLINE_CALL_BYTES = 4 * 1024 * 1024
const CHANGE_KEYS: ReadonlySet<string> = new Set(['path', 'text', 'base64', 'edits', 'delete'])
/** Where a file too large to send inline goes instead. */
const WRITE_IT = "write the file into the Motif's folder (read_motif answers its path)"

/** Decode one `{path, base64}` entry: canonical base64 only, bounded before decoding. */
function inlineBytes(filePath: string, base64: string): Buffer {
  if (base64.length > Math.ceil(INLINE_FILE_BYTES / 3) * 4)
    throw new Error(`${filePath}: base64 is over 256 KiB decoded; ${WRITE_IT}`)
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64)
    throw new Error(`${filePath}: invalid base64; send the file's canonical base64 (A-Z a-z 0-9 + /, = padding, no whitespace)`)
  return bytes
}

/** Apply edits in order, each against the text the previous one left. A miss or
 *  an ambiguous match refuses the whole batch, so a client resends a small diff
 *  rather than the complete file. */
function applyEdits(filePath: string, bytes: Buffer | undefined, edits: TextEdit[]): Buffer {
  if (!bytes)
    throw new Error(`Cannot edit ${filePath}: no such file in the Motif`)
  let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  edits.forEach((edit, i) => {
    const where = `${filePath} edit ${i + 1}`
    if (!edit || typeof edit.old !== 'string' || !edit.old || typeof edit.new !== 'string')
      throw new Error(`${where}: needs a non-empty old text and a new text`)
    const at = text.indexOf(edit.old)
    if (at < 0)
      throw new Error(`${where}: old text not found; read the file again`)
    let count = 0
    for (let k = at; k >= 0; k = text.indexOf(edit.old, k + 1))
      count++
    if (count > 1)
      throw new Error(`${where}: old text matches ${count} times; include more surrounding text`)
    text = text.slice(0, at) + edit.new + text.slice(at + edit.old.length)
  })
  return Buffer.from(text)
}

/** The batch `changes` applied to `files`: each changed path's new bytes,
 *  null for a deleted one. Throws, naming the entry, at the first entry that
 *  is malformed or cannot apply; nothing is written here. */
export function fileChanges(files: readonly MotifFile[], changes: unknown): Map<string, Buffer | null> {
  if (!Array.isArray(changes) || !changes.length || changes.length > 10000)
    throw new Error('Provide 1–10000 file changes')
  const current = new Map(files.map(f => [f.path, f.bytes]))
  const out = new Map<string, Buffer | null>()
  const touched = new Set<string>()
  let inline = 0
  for (const change of changes as FileChange[]) {
    if (!change || typeof change !== 'object')
      throw new Error('Each file change is an object with a path')
    if ('file_id' in change)
      throw new Error(`${String(change.path)}: file_id uploads are gone; send {path, base64} (at most 256 KiB decoded), or ${WRITE_IT}`)
    const unknown = Object.keys(change).find(k => !CHANGE_KEYS.has(k))
    if (unknown !== undefined)
      throw new Error(`${String(change.path)}: a file change takes path plus one of text, base64, edits or delete:true, not ${unknown}`)
    if (typeof change.path !== 'string' || !motifFileSegments(change.path))
      throw new Error('Invalid file path')
    if (touched.has(change.path.toLowerCase()))
      throw new Error('Duplicate file change: ' + change.path)
    touched.add(change.path.toLowerCase())
    const hasEdits = Array.isArray(change.edits) && change.edits.length > 0
    const kinds = Number(typeof change.text === 'string') + Number(typeof change.base64 === 'string') + Number(change.delete === true) + Number(hasEdits)
    if (kinds !== 1 || (change.edits !== undefined && !hasEdits))
      throw new Error('Each file change needs exactly one of text, base64, edits or delete:true')
    if (change.delete)
      out.set(change.path, null)
    else if (hasEdits)
      out.set(change.path, applyEdits(change.path, current.get(change.path), change.edits!))
    else if (change.base64 !== undefined) {
      const bytes = inlineBytes(change.path, change.base64)
      inline += bytes.length
      if (inline > INLINE_CALL_BYTES)
        throw new Error(`base64 entries total over 4 MiB decoded in one call; split the batch, or ${WRITE_IT}`)
      out.set(change.path, bytes)
    }
    else
      out.set(change.path, Buffer.from(change.text!))
  }
  return out
}
