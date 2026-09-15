import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import afterPackSkill from './after-pack-skill.mjs'
import { stampSkillVersion } from './build-skills-lib.mjs'

const SKILL = `---
name: weftcut
description: Drive the WeftCut video editor over its MCP tools.
---

# Driving WeftCut
`

/// A packed app whose <resources>/skills holds what the caller asks for.
/// electron-builder hands the hook an appOutDir and a packager that knows where
/// resources live under it; both are stubbed to that one relationship.
function packed(t, { version = '0.1.7', staged = version } = {}) {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-packed-'))
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }))
  const resources = path.join(appOutDir, 'resources')
  if (staged !== null) {
    const skill = path.join(resources, 'skills', 'weftcut')
    fs.mkdirSync(skill, { recursive: true })
    fs.writeFileSync(path.join(skill, 'SKILL.md'), stampSkillVersion(SKILL, staged))
    fs.writeFileSync(path.join(skill, 'motif-authoring.md'), 'the contract')
  }
  return { appOutDir, packager: { getResourcesDir: (dir) => path.join(dir, 'resources'), appInfo: { version } } }
}

test('a package carrying this version of the skill passes the gate', t => {
  assert.doesNotThrow(() => afterPackSkill(packed(t)))
})

test('extraResources dropping the bundle stops the build before it becomes a distributable', t => {
  assert.throws(() => afterPackSkill(packed(t, { staged: null })), /afterPack\(skill\).*no skill folders/s)
})

test('a bundle left over from an earlier version is caught by its stamp', t => {
  assert.throws(() => afterPackSkill(packed(t, { version: '0.1.7', staged: '0.1.6' })), /carries version 0\.1\.6/)
})

test('no app version means the stamp cannot be judged, which is itself a failure', t => {
  const context = packed(t)
  context.packager.appInfo.version = undefined
  assert.throws(() => afterPackSkill(context), /reported no app version/)
})
