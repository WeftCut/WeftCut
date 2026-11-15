import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { fileURLToPath } from 'node:url'
import { requireSigningCredentials, verifySignedApp, signingConfig } from './package-macos-release.mjs'

const env = {
  CSC_LINK: 'certificate fixture', CSC_KEY_PASSWORD: 'export password fixture',
  APPLE_ID: 'release@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'notary password fixture',
  APPLE_TEAM_ID: 'ABCD123456',
}

test('signed packaging refuses incomplete credentials before building', () => {
  requireSigningCredentials(env, 'darwin')
  for (const name of Object.keys(env)) {
    assert.throws(() => requireSigningCredentials({ ...env, [name]: ' ' }, 'darwin'), new RegExp(name))
  }
  assert.throws(() => requireSigningCredentials(env, 'win32'), /macOS host/)
  assert.throws(() => requireSigningCredentials({ ...env, APPLE_TEAM_ID: '-' }, 'darwin'), /Invalid APPLE_TEAM_ID/)
})

test('electron-builder merges signed settings without duplicating or losing bundled resources', async () => {
  const { getConfig, validateConfiguration } = await import('app-builder-lib/out/util/config/config.js')
  const { DebugLogger } = await import('builder-util')
  const desktop = fileURLToPath(new URL('../', import.meta.url))
  const base = await getConfig(desktop, null, null)
  const signed = await getConfig(desktop, null, signingConfig(env.APPLE_TEAM_ID))
  await validateConfiguration(signed, new DebugLogger(false))
  assert.equal(signed.mac.identity, env.APPLE_TEAM_ID)
  assert.equal(signed.mac.notarize, true)
  assert.equal(signed.mac.hardenedRuntime, true)
  assert.equal(signed.forceCodeSigning, true)
  assert.deepEqual(signed.mac.extraResources, base.mac.extraResources)
  assert.deepEqual(signed.extraResources, base.extraResources)
  assert.deepEqual(signed.files, base.files)
  assert.equal(signed.afterPack, base.afterPack)
  assert.equal(signed.appId, base.appId)
})

test('release verification refuses ad-hoc and other-team signatures', () => {
  for (const details of ['Signature=adhoc\nTeamIdentifier=not set',
    'Authority=Developer ID Application: Fixture\nTeamIdentifier=OTHER12345']) {
    assert.throws(() => verifySignedApp('Fixture.app', env.APPLE_TEAM_ID, () => details), /expected Developer ID team/)
  }
})

test('release verification requires a valid ticket and Gatekeeper acceptance', () => {
  for (const failure of ['codesign', 'xcrun', 'spctl', null]) {
    const execute = (command) => {
      if (command === failure) throw new Error(`${command} rejected fixture`)
      return `Authority=Developer ID Application: Fixture\nTeamIdentifier=${env.APPLE_TEAM_ID}\n`
    }
    if (failure) assert.throws(() => verifySignedApp('Fixture.app', env.APPLE_TEAM_ID, execute), /rejected fixture/)
    else verifySignedApp('Fixture.app', env.APPLE_TEAM_ID, execute)
  }
})

test('workflow signs main releases and manual packages, with no credential fallback or PR signing', () => {
  const workflow = parse(readFileSync(new URL('../../../.github/workflows/electron-ci.yml', import.meta.url), 'utf8'))
  const steps = workflow.jobs.e2e.steps
  const unsigned = steps.find(step => step.name === 'Package (unsigned)')
  const signed = steps.find(step => step.name === 'Package signed macOS release')
  const enabled = (step, context) => {
    const expression = step.if.replaceAll('needs.release-plan', 'needs["release-plan"]')
    return Function('runner', 'github', 'needs', 'inputs', 'matrix', `return (${expression})`)(...context)
  }
  for (const os of ['macOS', 'Windows', 'Linux']) {
    for (const [event, ref, repository, publish, packaging, expected] of [
      ['push', 'refs/heads/main', 'WeftCut/WeftCut', 'true', true, 'signed'],
      ['push', 'refs/heads/main', 'WeftCut/WeftCut', 'false', true, 'unsigned'],
      ['pull_request', 'refs/pull/1/merge', 'WeftCut/WeftCut', '', true, 'unsigned'],
      ['push', 'refs/heads/main', 'example/fork', '', true, 'unsigned'],
      ['workflow_dispatch', 'refs/heads/main', 'WeftCut/WeftCut', '', true, 'signed'],
      ['workflow_dispatch', 'refs/heads/feature', 'WeftCut/WeftCut', '', true, 'unsigned'],
      ['workflow_dispatch', 'refs/heads/main', 'WeftCut/WeftCut', '', false, 'none'],
    ]) {
      for (const part of ['e2e-1', 'e2e-2', 'all']) {
        const context = [{ os }, { event_name: event, ref, repository },
          { 'release-plan': { outputs: { publish } } }, { package: packaging }, { part }]
        const actual = [unsigned, signed].filter(step => enabled(step, context))
        const target = part === 'e2e-1' || expected === 'none' ? null
          : os === 'macOS' && expected === 'signed' ? signed : unsigned
        assert.deepEqual(actual, target ? [target] : [], `${os} ${event} ${ref} ${part}`)
      }
    }
  }
  assert.equal(unsigned.env, undefined)
  for (const name of Object.keys(env)) assert.equal(signed.env[name], '${{ secrets.' + name + ' }}')
  assert.match(signed.run, /node scripts\/package-macos-release\.mjs/)
})
