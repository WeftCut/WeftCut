import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = fileURLToPath(new URL('../', import.meta.url))
const REQUIRED = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']

export function requireSigningCredentials(env = process.env, platform = process.platform) {
  if (platform !== 'darwin') throw new Error('Signed macOS packaging requires a macOS host')
  const missing = REQUIRED.filter(name => !env[name]?.trim())
  if (missing.length) throw new Error(`Missing macOS release credentials: ${missing.join(', ')}`)
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('Invalid APPLE_TEAM_ID')
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  return `${result.stdout}\n${result.stderr}`
}

export function signingConfig(teamId) {
  return {
    extends: null,
    forceCodeSigning: true,
    mac: {
      identity: teamId,
      type: 'distribution',
      hardenedRuntime: true,
      notarize: true,
    },
  }
}

export function verifySignedApp(appPath, teamId, execute = run) {
  execute('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const details = execute('codesign', ['--display', '--verbose=4', appPath])
  if (!details.split(/\r?\n/).includes(`TeamIdentifier=${teamId}`) ||
      !/^Authority=Developer ID Application:/m.test(details)) {
    throw new Error('Packaged app is not signed with the expected Developer ID team')
  }
  // electron-builder 26 can skip notarization without failing the build.
  // A stapled ticket and Gatekeeper acceptance must both be present to ship.
  execute('xcrun', ['stapler', 'validate', appPath])
  execute('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath])
}

async function main() {
  requireSigningCredentials()
  const { build, Platform, Arch } = await import('electron-builder')
  await build({
    projectDir: DESKTOP,
    targets: Platform.MAC.createTarget('dmg', Arch.arm64),
    publish: 'never',
    config: signingConfig(process.env.APPLE_TEAM_ID),
  })
  verifySignedApp(path.join(DESKTOP, 'release/mac-arm64/WeftCut.app'), process.env.APPLE_TEAM_ID)
  console.log('macOS release: Developer ID signature, stapled ticket and Gatekeeper verified')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
