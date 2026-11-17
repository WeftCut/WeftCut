// The signed, notarized macOS release package (docs/releases.md §macOS signing).
// One command per workflow step, so a notarization that outlasts its wait is
// resumed from the submitted DMG instead of rebuilt and submitted again:
//
//   build   sign the app, the DMG and the update zip with the Developer ID; no notarization
//   submit  hand the DMG to Apple's notary service and record the submission
//   finish  wait for the verdict, staple the DMG, verify it and the zip's app,
//           re-stamp latest-mac.yml
//
// Usage (from apps/desktop): node scripts/package-macos-release.mjs <command>
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = fileURLToPath(new URL('../', import.meta.url))
const RELEASE = path.join(DESKTOP, 'release')
export const DMG = 'WeftCut-mac-arm64.dmg'
/// What electron-updater downloads and hands to Squirrel.Mac (docs/releases.md).
export const ZIP = 'WeftCut-mac-arm64.zip'
export const MANIFEST = 'latest-mac.yml'
export const SUBMISSION = 'notary-submission.json'

const SIGNING = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_TEAM_ID']
const NOTARY = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_TEAM_ID']
export const CREDENTIALS = { build: SIGNING, submit: NOTARY, finish: NOTARY }

/// Apple's terminal refusals. Anything else after the wait (still In Progress,
/// or a status read that failed) leaves the submission worth resuming.
const REJECTED = new Set(['Invalid', 'Rejected'])

export function requireCredentials(command, env = process.env, platform = process.platform) {
  if (platform !== 'darwin') throw new Error('Signed macOS packaging requires a macOS host')
  const names = CREDENTIALS[command]
  if (!names) throw new Error(`Unknown command: ${command}`)
  const missing = names.filter(name => !env[name]?.trim())
  if (missing.length) throw new Error(`Missing macOS release credentials: ${missing.join(', ')}`)
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID)) throw new Error('Invalid APPLE_TEAM_ID')
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${result.stderr || result.stdout}`)
  return `${result.stdout}\n${result.stderr}`
}

function jsonIn(output) {
  return JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1))
}

// Notarization is left to `submit`/`finish` rather than electron-builder, whose
// notarize step waits on Apple with no bound and submits the app, not the DMG
// users download. The DMG is signed so that it can be notarized and stapled.
export function signingConfig(teamId) {
  return {
    extends: null,
    forceCodeSigning: true,
    mac: {
      identity: teamId,
      type: 'distribution',
      hardenedRuntime: true,
      notarize: false,
    },
    dmg: { sign: true },
  }
}

/// The app carries a Developer ID signature of the expected team. Says nothing
/// about notarization: Gatekeeper refuses a hardened Developer ID app until
/// Apple has accepted it.
export function verifyDeveloperId(appPath, teamId, execute = run) {
  execute('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const details = execute('codesign', ['--display', '--verbose=4', appPath])
  if (!details.split(/\r?\n/).includes(`TeamIdentifier=${teamId}`) ||
      !/^Authority=Developer ID Application:/m.test(details)) {
    throw new Error('Packaged app is not signed with the expected Developer ID team')
  }
}

/// What a user's Mac checks on a downloaded DMG: its stapled ticket, Gatekeeper
/// on the image, then the app inside it, which is the copy that gets installed.
export function verifyNotarizedDmg(dmgPath, teamId, execute = run) {
  execute('xcrun', ['stapler', 'validate', dmgPath])
  execute('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmgPath])
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-dmg-'))
  execute('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmgPath])
  try {
    const app = path.join(mount, 'WeftCut.app')
    verifyDeveloperId(app, teamId, execute)
    execute('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
  } finally {
    execute('hdiutil', ['detach', mount, '-force'])
    fs.rmSync(mount, { recursive: true, force: true })
  }
}

/// The update zip holds the same signed app as the DMG, from the same build, so
/// the DMG's notarization covers it: Apple records the app's code hash, and
/// Gatekeeper finds it online even though only the DMG carries a stapled
/// ticket. Squirrel installs an update without quarantine, so Gatekeeper never
/// assesses it on a user's Mac; this check is what proves the zip is the
/// notarized app rather than some other build.
export function verifyZipApp(zipPath, teamId, execute = run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-zip-'))
  try {
    execute('ditto', ['-x', '-k', zipPath, dir])
    const app = path.join(dir, 'WeftCut.app')
    verifyDeveloperId(app, teamId, execute)
    execute('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/// notarytool arguments for the App Store Connect API key. notarytool takes the
/// key as a file, so it lives in a private temp file for the call and no longer.
export function withNotaryKey(env, use) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-notary-'))
  const key = path.join(dir, `AuthKey_${env.APPLE_API_KEY_ID}.p8`)
  try {
    fs.writeFileSync(key, env.APPLE_API_KEY.trim() + '\n', { mode: 0o600 })
    return use(['--key', key, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function submit(release, env, execute = run) {
  const output = withNotaryKey(env, auth => execute('xcrun',
    ['notarytool', 'submit', path.join(release, DMG), ...auth, '--no-wait', '--output-format', 'json']))
  const { id } = jsonIn(output)
  if (!id) throw new Error(`notarytool returned no submission id: ${output}`)
  fs.writeFileSync(path.join(release, SUBMISSION), JSON.stringify({ id }) + '\n')
  return id
}

/// Waits up to `timeout` (notarytool's form, e.g. "40m") for Apple's verdict.
/// Returns on acceptance; throws with `pending: true` when the submission is
/// still worth resuming, and with Apple's log when it was refused.
export function awaitVerdict(release, env, timeout, execute = run) {
  const { id } = JSON.parse(fs.readFileSync(path.join(release, SUBMISSION), 'utf8'))
  withNotaryKey(env, auth => {
    try {
      execute('xcrun', ['notarytool', 'wait', id, ...auth, '--timeout', timeout])
    } catch {
      // A timeout and a refusal both exit non-zero; the status read tells them apart.
    }
    let status
    try {
      status = jsonIn(execute('xcrun', ['notarytool', 'info', id, ...auth, '--output-format', 'json'])).status
    } catch (error) {
      throw Object.assign(new Error(`Could not read notarization ${id}: ${error.message}`), { pending: true })
    }
    if (status === 'Accepted') return
    if (REJECTED.has(status)) {
      let log = ''
      try { log = execute('xcrun', ['notarytool', 'log', id, ...auth]) } catch { /* the status is the verdict */ }
      throw new Error(`Apple refused notarization ${id} (${status})\n${log}`)
    }
    throw Object.assign(new Error(`Notarization ${id} is still ${status} after ${timeout}; ` +
      're-run the failed jobs to resume it without rebuilding'), { pending: true })
  })
}

/// Stapling rewrites the DMG, so the size and hash latest-mac.yml recorded at
/// build time no longer match it, which release.mjs validateAssets refuses.
/// The DMG blockmap goes stale the same way, and nothing consumes it.
export async function restampManifest(release) {
  const { parse, stringify } = await import('yaml')
  const file = path.join(release, MANIFEST)
  const manifest = parse(fs.readFileSync(file, 'utf8'))
  const dmg = path.join(release, DMG)
  const hash = createHash('sha512')
  for await (const chunk of fs.createReadStream(dmg)) hash.update(chunk)
  const sha512 = hash.digest('base64')
  const size = fs.statSync(dmg).size
  const entries = (manifest.files ?? []).filter(entry => decodeURIComponent(entry.url) === DMG)
  if (!entries.length) throw new Error(`${MANIFEST} does not list ${DMG}`)
  for (const entry of entries) Object.assign(entry, { size, sha512 })
  if (manifest.path === DMG) manifest.sha512 = sha512
  fs.writeFileSync(file, stringify(manifest))
  fs.rmSync(path.join(release, `${DMG}.blockmap`), { force: true })
}

async function main(command) {
  requireCredentials(command)
  const env = process.env
  if (command === 'build') {
    const { build, Platform, Arch } = await import('electron-builder')
    await build({
      projectDir: DESKTOP,
      targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64),
      publish: 'never',
      config: signingConfig(env.APPLE_TEAM_ID),
    })
    verifyDeveloperId(path.join(RELEASE, 'mac-arm64/WeftCut.app'), env.APPLE_TEAM_ID)
    console.log('macOS release: Developer ID signature verified')
  } else if (command === 'submit') {
    console.log(`macOS release: notarization submission ${submit(RELEASE, env)}`)
  } else {
    try {
      awaitVerdict(RELEASE, env, env.NOTARY_TIMEOUT || '40m')
    } catch (error) {
      if (error.pending && env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, 'pending=true\n')
      throw error
    }
    run('xcrun', ['stapler', 'staple', path.join(RELEASE, DMG)])
    verifyNotarizedDmg(path.join(RELEASE, DMG), env.APPLE_TEAM_ID)
    verifyZipApp(path.join(RELEASE, ZIP), env.APPLE_TEAM_ID)
    await restampManifest(RELEASE)
    console.log('macOS release: notarized, stapled and Gatekeeper-accepted, update zip covered')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1 })
}
