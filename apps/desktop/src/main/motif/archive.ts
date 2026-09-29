import { readFileSync, statSync } from 'node:fs'
import { unzipSync, zipSync, type Zippable } from 'fflate'
import { motifFileSegments, type MotifFile } from './packageFiles'

// Bound both the archive read and the expanded snapshot before writing a draft.
const MAX_BYTES = 256 * 1024 * 1024
const MAX_ENTRIES = 10_000

/** ZIP paths must also be unambiguous on case-insensitive filesystems. */
function pathValidator(): (name: string, directory: boolean) => void {
  const entries = new Set<string>()
  const nodes = new Map<string, { name: string; directory: boolean }>()
  return (name, directory) => {
    const parts = motifFileSegments(name)
    if (!parts) throw new Error(`Invalid Motif ZIP path: ${name}`)
    const key = name.toLowerCase()
    if (entries.has(key)) throw new Error(`Duplicate Motif ZIP path: ${name}`)
    entries.add(key)
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/')
      const isDir = i < parts.length || directory
      const prev = nodes.get(prefix.toLowerCase())
      if (prev && (prev.name !== prefix || prev.directory !== isDir)) {
        throw new Error(`Conflicting Motif ZIP path: ${name}`)
      }
      nodes.set(prefix.toLowerCase(), { name: prefix, directory: isDir })
    }
  }
}

/** Accept index.html at ZIP root or inside exactly one enclosing folder.
 * Entries become bytes only: ZIP attributes never create symlinks on disk. */
export function decodeMotifZip(bytes: Uint8Array): MotifFile[] {
  if (bytes.length < 22 || bytes.length > MAX_BYTES) throw new Error('Invalid Motif ZIP size (maximum 256 MiB)')
  const validate = pathValidator()
  let total = 0
  let count = 0
  const expected = new Map<string, number>()
  const entries = unzipSync(bytes, { filter(entry) {
    if (++count > MAX_ENTRIES) throw new Error('Motif ZIP has too many entries')
    const directory = entry.name.endsWith('/')
    validate(directory ? entry.name.slice(0, -1) : entry.name, directory)
    total += Math.max(entry.originalSize, entry.size)
    if (!Number.isSafeInteger(total) || total > MAX_BYTES) throw new Error('Motif ZIP exceeds 256 MiB expanded size')
    if (directory) return false
    expected.set(entry.name, entry.originalSize)
    return true
  } })
  const names = Object.keys(entries)
  if (names.length !== expected.size) throw new Error('Invalid Motif ZIP entries')
  let prefix = ''
  if (!names.includes('index.html')) {
    const root = names[0]?.split('/')[0]
    if (!root || !names.includes(`${root}/index.html`) || !names.every(n => n.startsWith(`${root}/`))) {
      throw new Error('A Motif ZIP must contain index.html at its root or in one Motif folder')
    }
    prefix = `${root}/`
  }
  return names.flatMap(name => {
    if (entries[name].length !== expected.get(name)) throw new Error(`Invalid Motif ZIP entry: ${name}`)
    const rel = name.slice(prefix.length)
    // Never accept an imported Update target (or a directory hiding under it).
    if (rel.split('/')[0].toLowerCase() === 'target') return []
    return [{ path: rel, bytes: Buffer.from(entries[name]) }]
  })
}

export function readMotifZip(file: string): MotifFile[] {
  if (statSync(file).size > MAX_BYTES) throw new Error('Motif ZIP exceeds 256 MiB')
  return decodeMotifZip(readFileSync(file))
}

/** Always export one named folder, retaining relative resource URLs. */
export function encodeMotifZip(id: string, files: readonly MotifFile[]): Uint8Array {
  if (motifFileSegments(id)?.length !== 1) throw new Error('Invalid Motif folder name')
  const entries: Zippable = Object.create(null)
  const validate = pathValidator()
  let total = 0
  let count = 0
  for (const file of files) {
    if (file.path.split('/')[0].toLowerCase() === 'target') continue
    validate(file.path, false)
    total += file.bytes.length
    if (++count > MAX_ENTRIES || total > MAX_BYTES) throw new Error('Motif package exceeds ZIP limits (256 MiB / 10000 files)')
    entries[`${id}/${file.path}`] = file.bytes
  }
  if (!files.some(f => f.path === 'index.html')) throw new Error('A Motif package must contain index.html')
  const bytes = zipSync(entries, { level: 6 })
  if (bytes.length > MAX_BYTES) throw new Error('Motif ZIP exceeds 256 MiB')
  return bytes
}
