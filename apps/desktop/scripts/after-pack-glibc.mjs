// electron-builder afterPack gate (Linux): every native library the app needs
// in order to start holds to the glibc floor (glibc-floor.mjs, issue #73).
//
// Both addon builds already run the same check on the .node they just produced,
// but a CI leg can restore those from the rust-artifacts cache instead of
// building them, and the libav* set arrives from a download. This runs against
// what actually landed in the package.
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { assertGlibcFloor, GLIBC_FLOOR } from './glibc-floor.mjs'

const LABEL = 'afterPack(glibc):'
const ADDONS = ['core', 'native-decode']

/**
 * The native libraries under the unpacked addon directories: each addon's
 * .node and the real files (not the SONAME symlinks) of the shared objects
 * co-located with it — the libav* set, and the libva that ffmpeg dlopens for
 * the VAAPI lane (held to the floor too, so no distro the app starts on loses
 * that lane to its glibc).
 */
export function linuxLibraries(resourcesDir) {
  const files = []
  for (const addon of ADDONS) {
    const dir = join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@weftcut', addon)
    if (!existsSync(dir)) throw new Error(`${LABEL} ${dir} is missing — the addon was not unpacked.`)
    for (const name of readdirSync(dir).sort()) {
      const isLib = name.endsWith('.node') || /\.so(\.\d+)*$/.test(name)
      if (!isLib) continue
      const path = join(dir, name)
      if (!lstatSync(path).isSymbolicLink()) files.push(path)
    }
  }
  return files
}

export default function afterPackGlibc(context, check = assertGlibcFloor) {
  if (context.electronPlatformName !== 'linux') return
  const files = linuxLibraries(context.packager.getResourcesDir(context.appOutDir))
  check(files, { label: LABEL })
  console.log(`  • ${LABEL} ${files.length} native libraries load on glibc ${GLIBC_FLOOR}.`)
}
