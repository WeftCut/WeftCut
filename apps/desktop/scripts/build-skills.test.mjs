import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stampSkillVersion } from './build-skills-lib.mjs'

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
