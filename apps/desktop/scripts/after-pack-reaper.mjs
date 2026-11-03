// The ffmpeg reaper (native/reaper) must ship beside the core addon on macOS
// and Linux: the addon starts it from there, and without it ffmpeg children
// outlive an app that dies (native/src/ffmpeg/guard.rs). It reaches the
// package through `files` + `asarUnpack`, two globs that degrade silently, so
// a missing or non-executable copy fails the pack here instead of shipping a
// build that only logs a warning. Windows uses a job object and ships none.
import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'

const LABEL = 'afterPack(reaper):'

/** Where the packaged reaper must be: beside the unpacked core addon. */
export function reaperPath(resourcesDir) {
  return join(resourcesDir, 'app.asar.unpacked', 'node_modules', '@weftcut', 'core', 'weftcut-reaper')
}

export default function afterPackReaper(context) {
  if (context.electronPlatformName === 'win32') return
  const path = reaperPath(context.packager.getResourcesDir(context.appOutDir))
  if (!existsSync(path)) {
    throw new Error(`${LABEL} ${path} is missing — run \`npm run napi:build\`, which builds it beside the addon.`)
  }
  try {
    accessSync(path, constants.X_OK)
  } catch {
    throw new Error(`${LABEL} ${path} is not executable.`)
  }
  console.log(`  • ${LABEL} the ffmpeg reaper ships beside the addon.`)
}
