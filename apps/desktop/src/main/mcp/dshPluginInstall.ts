// The app's side of the DeepSeek Harness plugin (ADR 0183): at every start it
// writes <userData>/dsh-plugin/, which the user adds to the Harness once by
// path. The plugin's patch carries the `weftcut` server entry, so the Harness
// runs this profile's binary; its browser half shows the side preview in a
// sidebar tab. The plugin's own files are plain JS in apps/desktop/dsh-plugin/,
// bundled into main at build time.
//
// Electron-free (paths ride in as arguments): `electron` cannot load under the
// unit runner.
import fs from 'node:fs'
import path from 'node:path'
import clientJs from '../../../dsh-plugin/client.js?raw'
import indexJs from '../../../dsh-plugin/index.js?raw'
import enJson from '../../../dsh-plugin/locale/en.json?raw'
import zhJson from '../../../dsh-plugin/locale/zh.json?raw'
import iconSvg from '../../../dsh-plugin/icon.svg?raw'
import readmeMd from '../../../dsh-plugin/README.md?raw'
import { SERVER_NAME, dshPluginDir, stdioEntry } from '../../shared/agentHosts'

/// The package name the Harness knows the plugin by. client.js registers its
/// browser module, tab type and sidebar ids under the same string.
export const DSH_PLUGIN_NAME = '@weftcut/dsh'

/// The Harness versions whose client seams the plugin was run against:
/// `sidebarRightTabs`, `tool.call.toolview`, `ctx.remote.commands`.
const DSH_ENGINES = '>=0.2.2-rc.5 <0.3.0'

/// JSON.stringify doubles as the YAML string encoder: a double-quoted YAML
/// scalar accepts every JSON escape, so a Windows backslash path survives.
const q = (s: string) => JSON.stringify(s)

function manifest(version: string): string {
  const pkg = {
    name: DSH_PLUGIN_NAME,
    version,
    description: "WeftCut's MCP server and side preview for DeepSeek Harness, written by WeftCut into its profile.",
    type: 'module',
    license: 'MIT',
    homepage: 'https://weftcut.com',
    private: true,
    engines: { dsh: DSH_ENGINES },
    exports: {
      '.': './index.js',
      './client': './client.js',
      './package.json': './package.json',
      './locale/*.json': './locale/*.json',
      './icon': './icon.svg',
    },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        immediately: true,
        // The client packages whose seams client.js uses, loaded first.
        inject: [
          '@deepseek-ai/dsh-api-remotes',
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-sidebar-right',
          '@deepseek-ai/dsh-client-ui-tool',
          '@deepseek-ai/dsh-client-ui-commands',
        ],
      },
    },
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

/// Two rows: the server, under the name the plugin's tool row and `/weftcut`
/// command call it by, and the plugin itself. The server's row id differs from
/// the `mcp-weftcut` id the older pasted entry used, so both rows load where
/// that entry is still in the home patch: this row takes the name, and the
/// pasted one fails with "already in use", which the Harness logs and boots past.
function patch(cliPath: string): string {
  const entry = stdioEntry(cliPath)
  return [
    '- insert:',
    '    - id: weftcut-mcp',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${SERVER_NAME}`,
    '        transport: stdio',
    `        command: ${q(entry.command)}`,
    `        args: [${entry.args.map(q).join(', ')}]`,
    '    - id: weftcut-preview',
    `      name: '${DSH_PLUGIN_NAME}'`,
    '',
  ].join('\n')
}

/// Every file of the plugin, by POSIX path relative to its folder.
export function dshPluginFiles(opts: { cliPath: string; version: string }): Map<string, string> {
  return new Map([
    ['package.json', manifest(opts.version)],
    ['cordis.patch.yml', patch(opts.cliPath)],
    ['index.js', indexJs],
    ['client.js', clientJs],
    ['locale/en.json', enJson],
    ['locale/zh.json', zhJson],
    ['icon.svg', iconSvg],
    ['README.md', readmeMd],
  ])
}

/// Writes the plugin beside the binary's folder and returns that folder, or
/// null when it could not be written. A file whose content is already right
/// is left alone. A running Harness serves a rewritten browser half at its
/// page's next load and runs a rewritten Host half from its next start; it
/// does not restart the server for either.
export function installDshPlugin(opts: { cliPath: string; version: string }): string | null {
  const dir = dshPluginDir(opts.cliPath)
  const tag = `${process.pid}-${Date.now().toString(36)}`
  try {
    for (const [rel, content] of dshPluginFiles(opts)) {
      const dest = path.join(dir, ...rel.split('/'))
      let current: string | null = null
      try {
        current = fs.readFileSync(dest, 'utf8')
      } catch {
        /* not written yet */
      }
      if (current === content) continue
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      // Renamed into place: the Harness reads the old file or the new one,
      // never a part of either.
      const temp = `${dest}.new-${tag}`
      try {
        fs.writeFileSync(temp, content)
        fs.renameSync(temp, dest)
      } catch (e) {
        fs.rmSync(temp, { force: true })
        throw e
      }
    }
    return dir
  } catch (error) {
    console.warn('[dsh-plugin] could not write the DeepSeek Harness plugin', error)
    return null
  }
}
