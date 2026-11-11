// electron-builder afterPack gate: the `weftcut` binary really landed in the
// distributable, with the licence of what it links.
//
// The binary is the stdio MCP entry (ADR 0165): the app copies it from here
// into the profile at every start, and a client config runs that copy. It
// reaches the package through `extraResources` from out/cli, a link that packs
// nothing without complaining when `npm run build:cli` did not run, or ran for
// another OS. A build without it would ship an app whose Connect panel has no
// stdio config to offer and whose older configs find nothing to serve them.
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LABEL = 'afterPack(cli):'

/** The Go licence beside the binary: BSD-3-Clause asks for it in a binary distribution. */
export const GO_LICENSE = 'GO-LICENSE.txt'

/** Where the packaged binary must be for `platform`. */
export function cliPath(resourcesDir, platform) {
  return join(resourcesDir, 'cli', platform === 'win32' ? 'weftcut.exe' : 'weftcut')
}

export default function afterPackCli(context) {
  const platform = context.electronPlatformName
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
  const path = cliPath(resourcesDir, platform)
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${LABEL} ${path} is missing — run \`npm run build:cli\` on this OS before packaging.`)
  }
  if (platform !== 'win32') {
    try {
      accessSync(path, constants.X_OK)
    } catch {
      throw new Error(`${LABEL} ${path} is not executable.`)
    }
  }
  const license = join(resourcesDir, 'cli', GO_LICENSE)
  if (!existsSync(license)) {
    throw new Error(`${LABEL} ${license} is missing — the Go licence was not carried (extraResources regression).`)
  }
  console.log(`  • ${LABEL} the weftcut binary and the Go licence ship in resources/cli.`)
}
