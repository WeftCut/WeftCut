// electron-builder afterPack gate: the packaged ffmpeg sidecar has every encoder
// export can select on this OS.
//
// The requirement is sidecar-encoders.json, one list of groups per OS; a group
// is met by any one of its encoders. It is derived from the export encoder
// catalog (native/src/export/encoder_registry.rs) and held to it by the Rust
// test `sidecar_encoder_requirement_matches_the_registry`, which prints the
// replacement file when they differ.
//
// The licensing gate checks the sidecar may ship; this one checks it can do the
// job. It lists the encoders of the binary that landed in the package rather than
// reading manifest.json, which fetch-ffmpeg.mjs keeps from an earlier fetch.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LABEL = 'afterPack(encoders):'

export const REQUIREMENT = JSON.parse(readFileSync(new URL('./sidecar-encoders.json', import.meta.url), 'utf8'))

/** Where the packaged sidecar must be for `platform`. */
export function sidecarPath(resourcesDir, platform) {
  return join(resourcesDir, 'ffmpeg', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
}

/** Encoder names in `ffmpeg -encoders` output: the second column of each row
 *  below the `------` divider (the rows above it are the flag legend). */
export function parseEncoderList(stdout) {
  const lines = stdout.split(/\r?\n/)
  const divider = lines.findIndex((line) => line.trim().startsWith('------'))
  if (divider < 0) throw new Error(`${LABEL} \`ffmpeg -encoders\` printed no encoder table.`)
  const names = new Set()
  for (const line of lines.slice(divider + 1)) {
    const [, name] = line.trim().split(/\s+/)
    if (name) names.add(name)
  }
  return names
}

/** Throws, naming each unmet group, unless `stdout` (an `ffmpeg -encoders`
 *  listing) meets every group `platform` requires. */
export function assertSidecarEncoders(platform, stdout) {
  const groups = REQUIREMENT[platform]
  if (!groups) throw new Error(`${LABEL} sidecar-encoders.json has no requirement for ${platform}.`)
  const available = parseEncoderList(stdout)
  const missing = groups.filter((group) => !group.anyOf.some((name) => available.has(name)))
  if (missing.length > 0) {
    const lines = missing.map((group) => `  - ${group.need}: ${group.anyOf.join(' or ')}`)
    throw new Error(
      `${LABEL} the ${platform} ffmpeg sidecar lacks encoders export selects:\n${lines.join('\n')}\n` +
        'Export would fail or fall back to another encoder. Pick a sidecar build that has them ' +
        '(fetch-ffmpeg.mjs), or change the encoder catalog and sidecar-encoders.json together.',
    )
  }
  return groups.length
}

export default function afterPackEncoders(context) {
  const platform = context.electronPlatformName
  const bin = sidecarPath(context.packager.getResourcesDir(context.appOutDir), platform)
  let stdout
  try {
    stdout = execFileSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`${LABEL} could not list the encoders of ${bin}: ${error.message}`)
  }
  const count = assertSidecarEncoders(platform, stdout)
  console.log(`  • ${LABEL} ${platform} ffmpeg sidecar meets all ${count} encoder requirements.`)
}
