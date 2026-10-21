// apps/desktop/src/main/taste/packages.ts
//
// Reading style packages and TASTE.md files off disk. A style is a directory
// whose STYLE.md carries YAML frontmatter (name, version, description, roles,
// tokens) and prose; any other files in it (Motifs, a caption preset, an
// exemplar) belong to the package and count toward its identity. The identity
// is a SHA-256 over every file's relative path and bytes, like a Motif
// package's revision, so a project can pin the exact package it was made with.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

export const STYLE_FILE = 'STYLE.md'
export const TASTE_FILE = 'TASTE.md'
/** Style and TASTE files are small; anything bigger is not one. */
const MAX_TEXT_BYTES = 256 * 1024
const MAX_PACKAGE_FILES = 1000

export interface Frontmatter {
  data: Record<string, unknown> | null
  prose: string
  /** Why `data` is null when the file has frontmatter that did not parse. */
  error?: string
}

/** Split `---\n<yaml>\n---\n<prose>`. A file without a leading fence is all
 *  prose with no data. */
export function readFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  if (!m) return { data: null, prose: src.trim() }
  const prose = src.slice(m[0].length).trim()
  try {
    const data = parseYaml(m[1]!, { maxAliasCount: 0 }) as unknown
    if (data === null || data === undefined) return { data: {}, prose }
    if (typeof data !== 'object' || Array.isArray(data)) return { data: null, prose, error: 'frontmatter is not a mapping' }
    return { data: data as Record<string, unknown>, prose }
  } catch (e) {
    return { data: null, prose, error: `frontmatter is not valid YAML: ${(e as Error).message.split('\n')[0]}` }
  }
}

export interface StylePackage {
  name: string
  dir: string
  hash: string
  frontmatter: Frontmatter
}

function walk(root: string, rel = '', out: string[] = []): string[] {
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) walk(root, r, out)
    else if (e.isFile()) out.push(r)
    if (out.length > MAX_PACKAGE_FILES) throw new Error(`style package has more than ${MAX_PACKAGE_FILES} files`)
  }
  return out
}

export function packageHash(dir: string): string {
  const hash = createHash('sha256')
  for (const rel of walk(dir)) {
    const bytes = readFileSync(path.join(dir, ...rel.split('/')))
    hash.update(JSON.stringify([rel, bytes.length])).update(bytes)
  }
  return hash.digest('hex')
}

function readText(file: string): string {
  if (statSync(file).size > MAX_TEXT_BYTES) throw new Error(`${path.basename(file)} is larger than ${MAX_TEXT_BYTES / 1024} KiB`)
  return readFileSync(file, 'utf8')
}

/** One package directory, or null when it has no STYLE.md. */
export function readStylePackage(dir: string): StylePackage | null {
  const file = path.join(dir, STYLE_FILE)
  if (!existsSync(file)) return null
  return { name: path.basename(dir), dir, hash: packageHash(dir), frontmatter: readFrontmatter(readText(file)) }
}

/** Package directories under `root` by folder name; a missing root is empty. */
export function listStyleDirs(root: string | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!root || !existsSync(root)) return out
  for (const e of readdirSync(root, { withFileTypes: true }))
    if (e.isDirectory() && !e.name.startsWith('.') && existsSync(path.join(root, e.name, STYLE_FILE))) out.set(e.name, path.join(root, e.name))
  return out
}

export interface TasteFile { path: string; text: string; frontmatter: Frontmatter }

/** The project's TASTE.md, or null when the project has none. */
export function readTasteFile(projectDir: string | null): TasteFile | { path: string; error: string } | null {
  if (!projectDir) return null
  const file = path.join(projectDir, TASTE_FILE)
  if (!existsSync(file)) return null
  try {
    const text = readText(file)
    return { path: file, text, frontmatter: readFrontmatter(text) }
  } catch (e) {
    return { path: file, error: (e as Error).message }
  }
}
