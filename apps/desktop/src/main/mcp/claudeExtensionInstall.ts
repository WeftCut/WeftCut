// The app's side of the Claude Desktop extension (ADR 0187): at every start it
// writes <userData>/claude-desktop/weftcut.mcpb, which the user opens in
// Claude Desktop once. The bundle is a manifest whose server runs this
// profile's binary, and the icon from apps/desktop/claude-extension/; nothing
// executable rides inside.
//
// Electron-free (paths ride in as arguments): `electron` cannot load under the
// unit runner.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { zipSync } from 'fflate'
import iconDataUrl from '../../../claude-extension/icon.png?inline'
import { SERVER_NAME, claudeExtensionPath, stdioEntry } from '../../shared/agentHosts'

/// Claude Desktop keeps an installed extension under
/// `local.mcpb.<author.name>.<name>`, both slugged. Changing either installs a
/// second extension beside the first instead of updating it. `name` is
/// SERVER_NAME: with no `display_name`, Claude keys the server by it, so a
/// pasted `weftcut` entry takes the same slot instead of running beside it.
export const CLAUDE_EXTENSION_AUTHOR = 'WeftCut'

/// The icon's PNG bytes, inlined into main as a base64 data URL at build time.
const ICON = Buffer.from(iconDataUrl.slice(iconDataUrl.indexOf(',') + 1), 'base64')

/// Every entry's zip timestamp, so equal content zips to equal bytes and a
/// start rewrites nothing. Built from local components: fflate encodes the
/// DOS date with local getters, so a UTC instant would shift with the zone.
const ZIP_MTIME = new Date(1980, 0, 1, 12)

export interface ClaudeExtensionFiles {
  /// `manifest.json`'s text.
  manifest: string
  /// `icon.png`'s bytes.
  icon: Uint8Array
}

function manifest(cliPath: string, version: string | undefined): string {
  const entry = stdioEntry(cliPath)
  const body = {
    manifest_version: '0.3',
    name: SERVER_NAME,
    version,
    description: 'Edit the project open in WeftCut. Runs the WeftCut installed on this computer, written by WeftCut into its profile.',
    author: { name: CLAUDE_EXTENSION_AUTHOR },
    icon: 'icon.png',
    server: {
      type: 'binary',
      // The schema requires an entry point; the binary is outside the bundle,
      // so it is the same absolute path the command names.
      entry_point: entry.command,
      mcp_config: { command: entry.command, args: [...entry.args] },
    },
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

/// The bundle's files for the binary at `cliPath`. The version follows the
/// content, not the app: Claude offers "Update" only for a bundle whose
/// version differs from the installed one, and an app release that changes
/// nothing here should offer none. A semver prerelease of digits alone may
/// not start with 0, so the hash rides behind a letter.
export function claudeExtensionFiles(opts: { cliPath: string }): ClaudeExtensionFiles {
  const hash = createHash('sha256')
    .update(manifest(opts.cliPath, undefined))
    .update(ICON)
    .digest('hex')
  return { manifest: manifest(opts.cliPath, `1.0.0-c${hash.slice(0, 12)}`), icon: ICON }
}

/// The `.mcpb` itself: a zip of the manifest and the icon, byte-identical for
/// identical files.
export function claudeExtensionBundle(opts: { cliPath: string }): Uint8Array {
  const files = claudeExtensionFiles(opts)
  return zipSync(
    {
      'manifest.json': new TextEncoder().encode(files.manifest),
      // Already deflated inside.
      'icon.png': [files.icon, { level: 0 }],
    },
    { level: 6, mtime: ZIP_MTIME },
  )
}

/// Writes the bundle into the profile and returns its path, or null when it
/// could not be written. A file whose bytes are already right is left alone.
/// Claude Desktop runs its own unzipped copy, so a rewrite reaches it only
/// when the user opens the bundle again.
export function installClaudeExtension(opts: { cliPath: string }): string | null {
  const dest = claudeExtensionPath(opts.cliPath)
  try {
    const bundle = claudeExtensionBundle(opts)
    let current: Buffer | null = null
    try {
      current = fs.readFileSync(dest)
    } catch {
      /* not written yet */
    }
    if (current?.equals(bundle)) return dest
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    // Renamed into place: Claude reads the old bundle or the new one, never a
    // part of either.
    const temp = `${dest}.new-${process.pid}-${Date.now().toString(36)}`
    try {
      fs.writeFileSync(temp, bundle)
      fs.renameSync(temp, dest)
    } catch (e) {
      fs.rmSync(temp, { force: true })
      throw e
    }
    return dest
  } catch (error) {
    console.warn('[claude-extension] could not write the Claude Desktop extension', error)
    return null
  }
}
