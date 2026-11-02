// apps/desktop/src/main/mcp/skillResources.ts
// The shipped skill as MCP resources, on SEP-2640's mapping: each file of the
// skill directory is `skill://weftcut/<path>`. A copy in a client's skills
// directory can go stale and the app cannot see it; this one is the running
// version's, so the instructions point here. Only SKILL.md is listed; the files
// beside it are read by the relative paths it names, or through the template.
//
// This serves the mapping and the pointer from the instructions, which need no
// negotiation. It does not declare the `io.modelcontextprotocol/skills`
// extension (`skills/list`, `skills/get`), which clients have barely adopted;
// the URIs already conform, so that is additive.
//
// Reads resolve against the files the bundle holds, by exact relative path, so a
// URI cannot name anything else: nothing here joins client input onto a path.

import fs from 'node:fs'
import path from 'node:path'
import { McpArgError } from '../state/mcp-commands.js'
import { resourceNotFound } from '../state/resource-views.js'

const SKILL = 'weftcut'
const PREFIX = `skill://${SKILL}/`
const ENTRY = 'SKILL.md'
export const SKILL_ENTRY_URI = `${PREFIX}${ENTRY}`

let root: string | null = null
let bundle: Map<string, string> | null = null

/// `skillsRoot` holds the `weftcut/` folder: the shipped bundle, never the
/// userData mirror, which a failed refresh leaves at an earlier version.
export function configureSkillBundle(skillsRoot: string): void {
  root = path.join(skillsRoot, SKILL)
  bundle = null
}

/// Relative path (with `/`) → absolute path of every regular file. A bundle
/// does not change while the app runs, so a found one is kept; a missing one
/// (dev tree before `build:skills`) is looked for again.
function files(): Map<string, string> {
  if (bundle) return bundle
  const found = new Map<string, string>()
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      else if (entry.isFile()) found.set(`${prefix}${entry.name}`, path.join(dir, entry.name))
    }
  }
  if (root && fs.existsSync(path.join(root, ENTRY))) {
    walk(root, '')
    bundle = found
  }
  return found
}

const MIME: Readonly<Record<string, string>> = { '.md': 'text/markdown', '.zip': 'application/zip' }
const mimeOf = (file: string): string => MIME[path.extname(file)] ?? 'application/octet-stream'
const isText = (file: string): boolean => mimeOf(file).startsWith('text/')

export function isSkillUri(uri: string): boolean {
  return uri.startsWith('skill://')
}

/// What `resources/list` carries: the entry alone, named and described from its
/// own frontmatter. Nothing when the bundle is missing, since nothing would read.
export function skillResourceDefs(): Array<{ uri: string; name: string; description: string; mimeType: string }> {
  const entry = files().get(ENTRY)
  if (!entry) return []
  const description = /^description: (.+)$/m.exec(fs.readFileSync(entry, 'utf8'))?.[1] ?? ''
  return [{ uri: SKILL_ENTRY_URI, name: SKILL, description, mimeType: 'text/markdown' }]
}

/// `resources/read` of a `skill://` URI. The whole relative path must match a
/// file of the bundle; anything else is the protocol's not-found.
export function readSkillResource(uri: string): { contents: Array<Record<string, string>> } {
  const relative = uri.startsWith(PREFIX) ? uri.slice(PREFIX.length) : null
  const file = relative === null ? undefined : files().get(relative)
  if (!file) {
    const known = [...files().keys()].sort()
    resourceNotFound(known.length
      ? `${uri} is not a file of the weftcut skill. Its files: ${known.join(', ')}`
      : 'The weftcut skill is not in this build (run build:skills)')
  }
  return isText(file)
    ? { contents: [{ uri, mimeType: mimeOf(file), text: fs.readFileSync(file, 'utf8') }] }
    : { contents: [{ uri, mimeType: mimeOf(file), blob: fs.readFileSync(file).toString('base64') }] }
}

/// `read_project { view: "skill", path }`, for a client without resources: the
/// file's text as the result. A binary file has no text form, so it is refused
/// by name rather than sent as noise.
export function readSkillView(relative: string): { content: Array<{ type: 'text'; text: string }> } {
  const file = files().get(relative)
  if (!file) {
    const known = [...files().keys()].sort()
    throw new McpArgError(known.length
      ? `'${relative}' is not a file of the weftcut skill. Its files: ${known.join(', ')}`
      : 'The weftcut skill is not in this build (run build:skills)', 'path')
  }
  if (!isText(file)) throw new McpArgError(`'${relative}' is binary: read ${PREFIX}${relative} as a resource, or take it from the app's skill folder (Settings > Agent)`, 'path')
  return { content: [{ type: 'text', text: fs.readFileSync(file, 'utf8') }] }
}
