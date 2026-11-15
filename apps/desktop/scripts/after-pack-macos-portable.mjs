// electron-builder afterPack gate (macOS): every Mach-O in the packaged app
// loads only system or bundled libraries and was built for the app's declared
// minimum macOS (macho-portability.mjs). The build host satisfies both by
// accident — Homebrew libraries on the runner, the runner's own macOS — so a
// binary that breaks either still starts there and in every CI check after it.
// Runs before signing, so a failure here never reaches notarization.
import { join } from 'node:path'
import { assertMacPortable, machOFiles, macMinimumSystemVersion } from './macho-portability.mjs'

const LABEL = 'afterPack(macos-portable):'

export default function afterPackMacosPortable(context, check = assertMacPortable) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const files = machOFiles(app)
  if (!files.length) throw new Error(`${LABEL} no Mach-O binaries found in ${app}`)
  const floor = macMinimumSystemVersion()
  check(files, { floor, label: LABEL })
  console.log(`  • ${LABEL} ${files.length} binaries load on macOS ${floor} with system libraries only.`)
}
