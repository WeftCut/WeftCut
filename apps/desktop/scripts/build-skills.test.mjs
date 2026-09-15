import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { assertSkillLayout, assertSkillVersions, stampSkillVersion } from './build-skills-lib.mjs'

const SKILL = `---
name: weftcut
description: Drive the WeftCut video editor over its MCP tools.
---

# Driving WeftCut
`

test('build:skills stamps the staged skill with the version of the app staging it', () => {
  const out = stampSkillVersion(SKILL, '0.1.7')
  assert.equal(
    out,
    `---
name: weftcut
description: Drive the WeftCut video editor over its MCP tools.
metadata:
  version: '0.1.7'
---

# Driving WeftCut
`,
  )
})

test('the version is quoted, so a two-part version stays a string instead of a float', () => {
  assert.match(stampSkillVersion(SKILL, '1.0'), /^ {2}version: '1\.0'$/m)
})

test('a skill with no frontmatter fails the build instead of shipping unstamped', () => {
  assert.throws(() => stampSkillVersion('# Driving WeftCut\n', '0.1.7'), /no YAML frontmatter/)
})

test('an author-written metadata block fails loudly rather than being clobbered', () => {
  const authored = SKILL.replace('description:', 'metadata:\n  license: MIT\ndescription:')
  assert.throws(() => stampSkillVersion(authored, '0.1.7'), /already declares metadata/)
})

/// A staged bundle, minus whatever the caller leaves out.
function bundle(t, { skills = ['weftcut'], docs = ['motif-authoring.md'], version = '0.1.7', skillFile = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-skill-bundle-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const skill of skills) {
    fs.mkdirSync(path.join(root, skill), { recursive: true })
    if (skillFile) fs.writeFileSync(path.join(root, skill, 'SKILL.md'), stampSkillVersion(SKILL, version))
  }
  for (const doc of docs) fs.writeFileSync(path.join(root, skills[0], doc), 'the contract')
  return root
}

test('a complete bundle passes and reports the skills it holds', t => {
  const root = bundle(t)
  assert.deepEqual(assertSkillLayout(root), ['weftcut'])
  assert.doesNotThrow(() => assertSkillVersions(root, ['weftcut'], '0.1.7'))
})

test('an empty bundle fails the build rather than shipping a panel with nothing to offer', t => {
  const root = bundle(t, { skills: [], docs: [] })
  assert.throws(() => assertSkillLayout(root), /no skill folders/)
  assert.throws(() => assertSkillLayout(path.join(root, 'never-staged')), /no skill folders/)
})

test('renaming the skill folder fails the build, because two other places name it literally', t => {
  const root = bundle(t, { skills: ['weftcut-editor'] })
  assert.throws(() => assertSkillLayout(root), /weftcut skill is missing/)
})

test('a skill folder without SKILL.md is not a skill any client would load', t => {
  const root = bundle(t, { skillFile: false })
  assert.throws(() => assertSkillLayout(root), /no SKILL\.md/)
})

test('a disclosed doc that did not get copied fails before it can dangle on a user machine', t => {
  const root = bundle(t, { docs: [] })
  assert.throws(() => assertSkillLayout(root), /motif-authoring\.md is not inside/)
})

test('an unstamped or mismatched skill fails: a copy that cannot name its app version is the drift hazard', t => {
  const unstamped = bundle(t, { skills: [], docs: [] })
  fs.mkdirSync(path.join(unstamped, 'weftcut'))
  fs.writeFileSync(path.join(unstamped, 'weftcut', 'SKILL.md'), SKILL)
  assert.throws(() => assertSkillVersions(unstamped, ['weftcut'], '0.1.7'), /carries version nothing/)

  const older = bundle(t, { version: '0.1.6' })
  assert.throws(() => assertSkillVersions(older, ['weftcut'], '0.1.7'), /carries version 0\.1\.6/)
})

test('every failure names the gate that raised it, so a pack-time one is not read as a build-time one', t => {
  const root = bundle(t, { skills: [], docs: [] })
  assert.throws(() => assertSkillLayout(root, { label: 'afterPack(skill):' }), /^Error: afterPack\(skill\):/)
})
