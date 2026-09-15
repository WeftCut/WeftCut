// electron-builder's single afterPack hook: the last point at which a build can
// still refuse to become a distributable. Each gate is its own module; this one
// only orders them.
//
// A gate belongs here when the thing it checks is staged by an earlier step and
// carried by `files`/`extraResources` — those two links degrade silently, so the
// supply-time check has to be re-run against what actually landed in the package.
import licensing from './after-pack-licensing.mjs'
import skill from './after-pack-skill.mjs'

export default function afterPack(context) {
  licensing(context)
  skill(context)
}
