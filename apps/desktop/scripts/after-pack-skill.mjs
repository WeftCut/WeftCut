// electron-builder afterPack gate: the agent skill bundle really landed in the
// distributable, and it names this app's version.
//
// build:skills already asserts the same thing over out/skills (the same two
// helpers run there), but that is at staging time. This runs against the files
// actually copied into the package, so a regression in the extraResources block
// — a renamed `from:`, a filter that stops matching, a build run without the
// build:skills step — cannot produce an installer whose agent panel has no
// skill to hand out. The panel treats a missing skill as an error state rather
// than hiding itself, and that error must be unreachable in a shipped build.
import { join } from 'node:path'
import { assertSkillLayout, assertSkillVersions } from './build-skills-lib.mjs'

const LABEL = 'afterPack(skill):'

export default function afterPackSkill(context) {
  // extraResources land under <resources>/ on every OS; getResourcesDir handles
  // the per-OS layout (macOS nests it under <App>.app/Contents/Resources).
  const dir = join(context.packager.getResourcesDir(context.appOutDir), 'skills')
  const version = context.packager.appInfo.version
  if (!version) {
    throw new Error(`${LABEL} the packager reported no app version, so the bundle's stamp cannot be checked.`)
  }
  const skills = assertSkillLayout(dir, { label: LABEL })
  assertSkillVersions(dir, skills, version, LABEL)
  console.log(`  • ${LABEL} ${skills.join(', ')} packed at ${version}.`)
}
