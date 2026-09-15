/// Stage the agent skill folder that ships with the app: the repo's skills/
/// tree plus the docs/ pages a skill tells the agent to read. Both live at the
/// repo root as the single source of truth — docs/motif-authoring.md is read by
/// humans there — so the skill bundle is assembled at build time instead of
/// keeping a second copy in the tree that could drift.
///
/// out/skills/ rides along as an extraResource and the app refreshes
/// <userData>/skills/ from it at startup (src/main/mcp/skillsInstall.ts).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertSkillLayout,
  assertSkillVersions,
  REQUIRED_DOCS,
  REQUIRED_SKILL,
  stampSkillVersion,
} from './build-skills-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..', '..')
const OUT = path.join(HERE, '..', 'out', 'skills')

// Clean first: a renamed or deleted skill file must not survive in the bundle.
fs.rmSync(OUT, { recursive: true, force: true })
fs.cpSync(path.join(REPO, 'skills'), OUT, { recursive: true })
// Docs land inside the required skill, so the layout has to hold before they
// can be placed. Asserting here rather than letting `copyFileSync` raise ENOENT
// is what turns "skills/ was emptied or renamed" into a message that says so.
const staged = assertSkillLayout(OUT, { requiredDocs: [] })
for (const doc of REQUIRED_DOCS) {
  fs.copyFileSync(path.join(REPO, 'docs', doc), path.join(OUT, REQUIRED_SKILL, doc))
}

// A copy on a user's machine outlives the session that installed it and can be
// reinstalled from any app version, so it has to say which one it came from.
const { version } = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
for (const skill of staged) {
  const at = path.join(OUT, skill, 'SKILL.md')
  fs.writeFileSync(at, stampSkillVersion(fs.readFileSync(at, 'utf8'), version))
}

assertSkillLayout(OUT)
assertSkillVersions(OUT, staged, version)

console.log(`[build:skills] staged ${staged.join(', ')} to ${path.relative(path.join(HERE, '..'), OUT)} at ${version}`)
