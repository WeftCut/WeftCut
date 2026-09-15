/// Pure helpers behind build-skills.mjs: the version stamp it writes into every
/// staged SKILL.md, and the two assertions that make an incomplete skill bundle
/// a failure instead of a shipped absence. Split out because that script stages
/// at module scope — a test that imported it would run the build.
///
/// The assertions are used twice over the same tree at different moments:
/// build:skills checks what it staged, and the electron-builder afterPack hook
/// re-checks what actually landed in the distributable
/// (scripts/after-pack-skill.mjs).
import fs from 'node:fs'
import path from 'node:path'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/// The skill folder name the rest of the system hard-codes: the Settings panel
/// builds `<userData>/skills/weftcut` by string concatenation (the renderer has
/// no `path`), and the install prompt names it to the user's agent. Renaming
/// `skills/weftcut/` has to fail the build rather than ship a panel pointing at
/// a folder nobody staged.
export const REQUIRED_SKILL = 'weftcut'

/// Docs copied verbatim into the required skill folder. A skill references
/// these by bare filename ("read motif-authoring.md next to this file"), so the
/// name has to survive the copy — and the same list is what the layout
/// assertion looks for afterwards.
export const REQUIRED_DOCS = ['motif-authoring.md']

/// Record the app version inside a SKILL.md's frontmatter.
///
/// It goes under `metadata`, the one key the Agent Skills spec reserves for an
/// author's own catalog data: a top-level `version` key is not in the spec's
/// field list, and the packagers reject unknown keys with a hard error rather
/// than ignoring them. Quoted, so a two-part version (`1.0`) stays a string
/// instead of parsing as a float.
///
/// Stamping happens while staging, never in the repo source: the version the
/// bundle carries is then the version of the app that built it by
/// construction, with nothing for a human to remember to bump.
export function stampSkillVersion(source, version) {
  const m = FRONTMATTER.exec(source)
  if (!m) throw new Error('SKILL.md has no YAML frontmatter to stamp')
  if (/^metadata:/m.test(m[1])) {
    throw new Error('SKILL.md already declares metadata: — fold the version stamp into it by hand')
  }
  return `---\n${m[1]}\nmetadata:\n  version: '${version}'\n---${m[2]}${source.slice(m[0].length)}`
}

/// The version a staged SKILL.md carries, or null if it carries none. Reads
/// back exactly the shape `stampSkillVersion` writes; anything else counts as
/// unstamped, which is a failure and never a fallback.
export function readSkillVersion(source) {
  return /^ {2}version: '([^']*)'$/m.exec(source)?.[1] ?? null
}

/// Assert a skill bundle has the shape an agent client can load, and return the
/// skill folder names in it.
///
/// Every later step of the delivery chain degrades quietly by design: `cpSync`
/// of an empty tree succeeds, an extraResource whose filter matches nothing
/// packs as nothing, and the startup install cannot tell an empty bundle from
/// an absent one. A distribution whose agent panel has no skill to hand out is
/// a defect, so the steps that still know the difference between "the bundle"
/// and "nothing" are the ones that refuse to pass it on.
export function assertSkillLayout(dir, opts = {}) {
  const { requiredSkill = REQUIRED_SKILL, requiredDocs = REQUIRED_DOCS, label = '[build:skills]' } = opts
  const skills = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : []
  if (skills.length === 0) {
    throw new Error(`${label} no skill folders in ${dir} — the agent panel would have nothing to hand out.`)
  }
  if (!skills.includes(requiredSkill)) {
    throw new Error(
      `${label} the ${requiredSkill} skill is missing (found: ${skills.join(', ')}). The Settings panel and the ` +
        'install prompt name that folder literally; rename both sides together or not at all.',
    )
  }
  for (const skill of skills) {
    if (!fs.existsSync(path.join(dir, skill, 'SKILL.md'))) {
      throw new Error(`${label} ${skill}/ has no SKILL.md — an agent client would not load it as a skill at all.`)
    }
  }
  for (const doc of requiredDocs) {
    if (!fs.existsSync(path.join(dir, requiredSkill, doc))) {
      throw new Error(
        `${label} ${doc} is not inside the ${requiredSkill} skill — a disclosed pointer would dangle on the user's machine.`,
      )
    }
  }
  return skills
}

/// Assert every skill in the bundle names the app version it was built from.
/// An unstamped or mismatched copy on a user's machine cannot say which app it
/// came from, which is the whole reason the stamp exists.
export function assertSkillVersions(dir, skills, version, label = '[build:skills]') {
  for (const skill of skills) {
    const stamped = readSkillVersion(fs.readFileSync(path.join(dir, skill, 'SKILL.md'), 'utf8'))
    if (stamped !== version) {
      throw new Error(`${label} ${skill}/SKILL.md carries version ${stamped ?? 'nothing'}, expected ${version}.`)
    }
  }
}
