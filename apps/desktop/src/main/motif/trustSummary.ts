// What the trust card says about a Motif's files before the user trusts it
// (spec § Trust): counts and sizes, and the signs of code worth a look,
// found by reading the bytes as text. Nothing here loads or runs a file.
import { isUtf8 } from 'node:buffer'
import type { MotifFile } from './packageFiles'

/** A file larger than this is not read for content. */
export const SCAN_FILE_BYTES = 2 * 1024 * 1024
/** Files past this many bytes into the package, in path order, are not read
 *  for content. */
export const SCAN_TOTAL_BYTES = 32 * 1024 * 1024
/** A script line at least this long may be minified code. */
export const MINIFIED_LINE_CHARS = 1000
/** ...when at least this share of it is code punctuation (`;{}()=,`): base64
 *  and prose stay below it. */
export const MINIFIED_PUNCTUATION_SHARE = 0.03
/** Summaries kept, by revision. */
const SUMMARIES_KEPT = 32

export interface MotifTrustSummary {
  /** Every file of the package. */
  files: number
  bytes: number
  /** Files read that are not UTF-8 text. */
  binary: number
  /** Script files (`.js`, `.mjs`, `.cjs`) and markup files holding `<script`. */
  scripts: { path: string; bytes: number }[]
  /** Files that start a Worker, a SharedWorker or a service worker, or import
   *  scripts into one. */
  workers: string[]
  /** WebAssembly modules (`.wasm`, or a file starting with its magic) and
   *  files that compile one. */
  wasm: string[]
  /** Scripts and markup with a long line dense in code punctuation, and the
   *  longest such line's length. */
  minified: { path: string; longest_line: number }[]
  /** Files not read for content: too large, or past the package's budget. */
  unscanned: string[]
}

const SCRIPT_FILE = /\.(?:js|mjs|cjs)$/i
const MARKUP_FILE = /\.(?:html?|xhtml|svg)$/i
const SCRIPT_TAG = /<script\b/i
const WORKER = /\bnew\s+(?:Shared)?Worker\s*\(|importScripts\s*\(|serviceWorker/
const WASM_CALL = /WebAssembly\.(?:instantiate|compile|Module)/
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d])
const PUNCTUATION = new Set([...';{}()=,'].map(c => c.charCodeAt(0)))

/** The summary of `files`, read in path order. */
export function summarizeMotifFiles(files: readonly MotifFile[]): MotifTrustSummary {
  const out: MotifTrustSummary = { files: files.length, bytes: 0, binary: 0, scripts: [], workers: [], wasm: [], minified: [], unscanned: [] }
  let offset = 0
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const size = file.bytes.length
    out.bytes += size
    offset += size
    const script = SCRIPT_FILE.test(file.path), markup = MARKUP_FILE.test(file.path)
    const wasm = /\.wasm$/i.test(file.path) || file.bytes.subarray(0, 4).equals(WASM_MAGIC)
    if (script) out.scripts.push({ path: file.path, bytes: size })
    if (size > SCAN_FILE_BYTES || offset > SCAN_TOTAL_BYTES) {
      if (wasm) out.wasm.push(file.path)
      out.unscanned.push(file.path)
      continue
    }
    if (!isUtf8(file.bytes)) {
      out.binary++
      if (wasm) out.wasm.push(file.path)
      continue
    }
    const text = file.bytes.toString('utf8')
    if (markup && SCRIPT_TAG.test(text)) out.scripts.push({ path: file.path, bytes: size })
    if (WORKER.test(text)) out.workers.push(file.path)
    if (wasm || WASM_CALL.test(text)) out.wasm.push(file.path)
    if (script || markup) {
      const longest = longestMinifiedLine(text)
      if (longest !== null) out.minified.push({ path: file.path, longest_line: longest })
    }
  }
  return out
}

/** The length of `text`'s longest line that reads as minified code; null
 *  when none does. */
function longestMinifiedLine(text: string): number | null {
  let longest: number | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.length < MINIFIED_LINE_CHARS || (longest !== null && line.length <= longest)) continue
    let punctuation = 0
    for (let i = 0; i < line.length; i++) if (PUNCTUATION.has(line.charCodeAt(i))) punctuation++
    if (punctuation / line.length >= MINIFIED_PUNCTUATION_SHARE) longest = line.length
  }
  return longest
}

const summaries = new Map<string, MotifTrustSummary>()

/** The summary of revision `revision`, whose files `files` reads; a
 *  revision is its bytes, so its summary is kept by it. */
export function motifTrustSummary(revision: string, files: () => readonly MotifFile[]): MotifTrustSummary {
  let summary = summaries.get(revision)
  if (summary) summaries.delete(revision)
  else summary = summarizeMotifFiles(files())
  summaries.set(revision, summary)
  if (summaries.size > SUMMARIES_KEPT) summaries.delete(summaries.keys().next().value!)
  return summary
}
