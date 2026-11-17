import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { fileURLToPath } from 'node:url'
import {
  CREDENTIALS, DMG, MANIFEST, SUBMISSION, ZIP, awaitVerdict, requireCredentials, restampManifest, signingConfig, submit,
  verifyDeveloperId, verifyNotarizedDmg, verifyZipApp,
} from './package-macos-release.mjs'
import { INSTALLERS } from './release.mjs'

const env = {
  CSC_LINK: 'certificate fixture', CSC_KEY_PASSWORD: 'export password fixture', APPLE_TEAM_ID: 'ABCD123456',
  APPLE_API_KEY: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----',
  APPLE_API_KEY_ID: 'KEY1234567', APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
}
const signed = `Authority=Developer ID Application: Fixture (${env.APPLE_TEAM_ID})\nTeamIdentifier=${env.APPLE_TEAM_ID}\n`

function tempRelease(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macos-release-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('each command refuses to start without the credentials it uses', () => {
  for (const [command, names] of Object.entries(CREDENTIALS)) {
    const needed = Object.fromEntries(names.map(name => [name, env[name]]))
    requireCredentials(command, needed, 'darwin')
    for (const name of names) {
      assert.throws(() => requireCredentials(command, { ...needed, [name]: ' ' }, 'darwin'), new RegExp(name))
    }
    assert.throws(() => requireCredentials(command, needed, 'win32'), /macOS host/)
    assert.throws(() => requireCredentials(command, { ...needed, APPLE_TEAM_ID: '-' }, 'darwin'), /Invalid APPLE_TEAM_ID/)
  }
  // Signing never needs the notary key, and notarizing never needs the certificate.
  assert.ok(!CREDENTIALS.build.includes('APPLE_API_KEY'))
  assert.ok(!CREDENTIALS.submit.includes('CSC_LINK') && !CREDENTIALS.finish.includes('CSC_LINK'))
})

test('electron-builder merges signed settings without duplicating or losing bundled resources', async () => {
  const { getConfig, validateConfiguration } = await import('app-builder-lib/out/util/config/config.js')
  const { DebugLogger } = await import('builder-util')
  const desktop = fileURLToPath(new URL('../', import.meta.url))
  const base = await getConfig(desktop, null, null)
  const config = await getConfig(desktop, null, signingConfig(env.APPLE_TEAM_ID))
  await validateConfiguration(config, new DebugLogger(false))
  assert.equal(config.mac.identity, env.APPLE_TEAM_ID)
  assert.equal(config.mac.hardenedRuntime, true)
  assert.equal(config.forceCodeSigning, true)
  // Notarization belongs to submit/finish, and the DMG it acts on must be signed.
  assert.equal(config.mac.notarize, false)
  assert.equal(config.dmg.sign, true)
  assert.deepEqual(config.mac.extraResources, base.mac.extraResources)
  assert.deepEqual(config.extraResources, base.extraResources)
  assert.deepEqual(config.files, base.files)
  assert.equal(config.afterPack, base.afterPack)
  assert.equal(config.appId, base.appId)
})

test('signature verification refuses ad-hoc and other-team signatures', () => {
  for (const details of ['Signature=adhoc\nTeamIdentifier=not set',
    'Authority=Developer ID Application: Fixture\nTeamIdentifier=OTHER12345']) {
    assert.throws(() => verifyDeveloperId('Fixture.app', env.APPLE_TEAM_ID, () => details), /expected Developer ID team/)
  }
  verifyDeveloperId('Fixture.app', env.APPLE_TEAM_ID, () => signed)
})

test('a DMG ships only with a ticket, Gatekeeper acceptance of image and app, and is always unmounted', () => {
  for (const failure of ['stapler', 'open', 'attach', 'codesign', 'execute', null]) {
    const calls = []
    const execute = (command, args) => {
      calls.push(args)
      const step = command === 'xcrun' ? args[0] : command === 'spctl' ? args[2] : command === 'hdiutil' ? args[0] : command
      if (step === failure) throw new Error(`${step} rejected fixture`)
      return signed
    }
    if (failure) assert.throws(() => verifyNotarizedDmg('Fixture.dmg', env.APPLE_TEAM_ID, execute), /rejected fixture/)
    else verifyNotarizedDmg('Fixture.dmg', env.APPLE_TEAM_ID, execute)
    const attached = calls.some(args => args[0] === 'attach')
    const detached = calls.some(args => args[0] === 'detach')
    assert.equal(detached, attached && failure !== 'attach', `mount left behind after ${failure}`)
  }
})

test('the update zip ships only when its app is the team\'s and Gatekeeper finds it notarized', () => {
  for (const failure of ['ditto', 'codesign', 'execute', null]) {
    const calls = []
    let extracted
    const execute = (command, args) => {
      calls.push([command, ...args])
      if (command === 'ditto') extracted = args[3]
      const step = command === 'spctl' ? args[2] : command
      if (step === failure) throw new Error(`${step} rejected fixture`)
      return signed
    }
    if (failure) assert.throws(() => verifyZipApp('Fixture.zip', env.APPLE_TEAM_ID, execute), /rejected fixture/)
    else verifyZipApp('Fixture.zip', env.APPLE_TEAM_ID, execute)
    assert.equal(fs.existsSync(extracted), false, `extraction left behind after ${failure}`)
    if (!failure) {
      assert.ok(calls.some(([command, ...args]) => command === 'spctl' && args.at(-1) === path.join(extracted, 'WeftCut.app')))
    }
  }
})

function notary(t, statuses) {
  const release = tempRelease(t)
  fs.writeFileSync(path.join(release, SUBMISSION), JSON.stringify({ id: 'submission-fixture' }))
  const keys = []
  const execute = (command, args) => {
    keys.push(args[args.indexOf('--key') + 1])
    const action = args[1]
    const outcome = statuses[action]
    if (outcome instanceof Error) throw outcome
    if (action === 'info') return JSON.stringify({ status: outcome })
    return outcome ?? ''
  }
  return { release, keys, execute }
}

test('a submission is recorded so a later attempt can resume it', t => {
  const release = tempRelease(t)
  const id = submit(release, env, () => '{"id":"submission-fixture","message":"Successfully uploaded file"}')
  assert.equal(id, 'submission-fixture')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(release, SUBMISSION), 'utf8')), { id })
})

test('the notary wait tells acceptance, an unfinished submission and a refusal apart', t => {
  const accepted = notary(t, { wait: '', info: 'Accepted' })
  awaitVerdict(accepted.release, env, '1m', accepted.execute)

  for (const statuses of [
    { wait: new Error('Timeout'), info: 'In Progress' },
    { wait: new Error('Timeout'), info: new Error('network unreachable') },
  ]) {
    const pending = notary(t, statuses)
    assert.throws(() => awaitVerdict(pending.release, env, '1m', pending.execute), error => error.pending === true)
  }

  const refused = notary(t, { wait: new Error('Invalid'), info: 'Invalid', log: 'The binary is not signed.' })
  assert.throws(() => awaitVerdict(refused.release, env, '1m', refused.execute),
    error => !error.pending && /Invalid/.test(error.message) && /not signed/.test(error.message))
  // The API key exists only for the calls that need it.
  for (const key of refused.keys) assert.equal(fs.existsSync(key), false)
})

test('the manifest describes the stapled DMG, not the one electron-builder hashed', async t => {
  const release = tempRelease(t)
  const dmg = path.join(release, DMG)
  fs.writeFileSync(dmg, 'unstapled')
  fs.writeFileSync(`${dmg}.blockmap`, 'stale')
  fs.writeFileSync(path.join(release, MANIFEST), stringify({
    version: '1.2.3', files: [{ url: DMG, sha512: 'stale', size: 9 }], path: DMG, sha512: 'stale',
  }))
  fs.appendFileSync(dmg, ' plus a stapled ticket')
  await restampManifest(release)
  const manifest = parse(fs.readFileSync(path.join(release, MANIFEST), 'utf8'))
  const sha512 = createHash('sha512').update(fs.readFileSync(dmg)).digest('base64')
  assert.deepEqual(manifest.files, [{ url: DMG, sha512, size: fs.statSync(dmg).size }])
  assert.equal(manifest.sha512, sha512)
  assert.equal(fs.existsSync(`${dmg}.blockmap`), false)
})

test('only the release job on main receives Apple credentials, after the test gates', () => {
  const workflow = parse(fs.readFileSync(new URL('../../../.github/workflows/electron-ci.yml', import.meta.url), 'utf8'))
  const job = workflow.jobs['package-macos']
  const holders = Object.entries(workflow.jobs).filter(([, body]) => JSON.stringify(body).includes('secrets.'))
  assert.deepEqual(holders.map(([name]) => name), ['package-macos'])
  assert.equal(job.environment, 'macos-release')
  for (const gate of ['e2e', 'checks', 'rust-test']) assert.ok(job.needs.includes(gate), gate)
  assert.ok(workflow.jobs.release.needs.includes('package-macos'))

  const enabled = (expression, github, publish, inputs) => Function('github', 'needs', 'inputs',
    `return (${expression.replaceAll('needs.release-plan', 'needs["release-plan"]')})`)(
    github, { 'release-plan': { outputs: { publish } } }, inputs)
  const main = { ref: 'refs/heads/main', repository: 'WeftCut/WeftCut' }
  for (const [github, publish, inputs, expected] of [
    [{ ...main, event_name: 'push' }, 'true', {}, true],
    [{ ...main, event_name: 'push' }, 'false', {}, false],
    [{ ...main, event_name: 'workflow_dispatch' }, '', { sign_macos: true }, true],
    [{ ...main, event_name: 'workflow_dispatch' }, '', { sign_macos: false }, false],
    [{ ...main, event_name: 'workflow_dispatch', ref: 'refs/heads/feature' }, '', { sign_macos: true }, false],
    [{ ...main, event_name: 'pull_request', ref: 'refs/pull/1/merge' }, '', {}, false],
    [{ ...main, event_name: 'push', repository: 'example/fork' }, 'true', {}, false],
  ]) {
    assert.equal(enabled(job.if, github, publish, inputs), expected, JSON.stringify([github, publish, inputs]))
  }

  // A release's macOS asset is the signed DMG alone: the e2e leg's unsigned one
  // is never uploaded for it, so the two cannot collide in release-assets.
  const upload = workflow.jobs.e2e.steps.find(step => step.name === 'Upload installer')
  const uploads = (os) => Function('success', 'matrix', 'github', 'inputs', 'needs', 'runner',
    `return (${upload.if.replaceAll('needs.release-plan', 'needs["release-plan"]')})`)(
    () => true, { part: 'e2e-2' }, { event_name: 'push' }, {}, { 'release-plan': { outputs: { publish: 'true' } } }, { os })
  assert.equal(uploads('macOS'), false)
  assert.equal(uploads('Windows'), true)

  // What release.mjs requires of macOS reaches the release, and a resumed
  // notarization finds every file the release needs without rebuilding.
  const macAssets = [...INSTALLERS['latest-mac.yml'], `${ZIP}.blockmap`, MANIFEST]
  const uploaded = name => job.steps.find(step => step.with?.name === name).with.path.split('\n')
    .map(line => line.trim()).filter(Boolean).map(file => path.basename(file))
  for (const artifact of ['installer-macos-signed', 'macos-notary-pending']) {
    for (const asset of macAssets) assert.ok(uploaded(artifact).includes(asset), `${artifact} lacks ${asset}`)
  }
  assert.ok(INSTALLERS['latest-mac.yml'].includes(DMG) && INSTALLERS['latest-mac.yml'].includes(ZIP))
})
