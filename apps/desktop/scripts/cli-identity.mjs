// The app's identity for the build scripts, read from its one home,
// cli/identity.json (the `weftcut` binary embeds the same file).
import { readFileSync } from 'node:fs'

/** @type {{ bundleId: string, productName: string, packageName: string, binaryName: string }} */
export const identity = JSON.parse(readFileSync(new URL('../cli/identity.json', import.meta.url), 'utf8'))

/** The `weftcut` binary's file name on `platform`. */
export function cliBinaryFile(platform) {
  return platform === 'win32' ? `${identity.binaryName}.exe` : identity.binaryName
}
