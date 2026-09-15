/// The version stamp that build-skills.mjs writes into every staged SKILL.md.
/// Split out because that script stages the bundle at module scope — a test
/// that imported it would run the build.

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

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
