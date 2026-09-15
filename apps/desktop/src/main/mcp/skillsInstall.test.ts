import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installSkills } from './skillsInstall.js'

const tmps: string[] = []
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-skills-install-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/// Stand-in for out/skills: one skill folder with the doc build-skills.mjs
/// stages beside it.
function stageSkills(root: string, body: string): string {
  fs.mkdirSync(path.join(root, 'weftcut'), { recursive: true })
  fs.writeFileSync(path.join(root, 'weftcut', 'SKILL.md'), body)
  fs.writeFileSync(path.join(root, 'weftcut', 'motif-authoring.md'), `doc for ${body}`)
  return root
}

/// A destination left by an earlier launch, for the cases that have to decide
/// between handing it out and reporting nothing.
function seedUserData(userData: string, body: string): string {
  return stageSkills(path.join(userData, 'skills'), body)
}

describe('installSkills', () => {
  it('copies the packaged tree into <userData>/skills and reports it installed', () => {
    const userData = tmpDir()
    const source = stageSkills(tmpDir(), 'skill v1')
    const got = installSkills({ resourcesSkills: source, devSkills: 'X:\\nope', isPackaged: true, userDataDir: userData })
    expect(got).toEqual({ state: 'installed', dir: path.join(userData, 'skills') })
    expect(fs.readFileSync(path.join(got.dir!, 'weftcut', 'SKILL.md'), 'utf8')).toBe('skill v1')
    expect(fs.readFileSync(path.join(got.dir!, 'weftcut', 'motif-authoring.md'), 'utf8')).toBe('doc for skill v1')
  })

  it('refreshes shipped files on every start but keeps what the user added', () => {
    const userData = tmpDir()
    const source = stageSkills(tmpDir(), 'skill v1')
    const opts = { resourcesSkills: source, devSkills: 'X:\\nope', isPackaged: true, userDataDir: userData }
    installSkills(opts)
    const mine = path.join(userData, 'skills', 'mine', 'SKILL.md')
    fs.mkdirSync(path.dirname(mine), { recursive: true })
    fs.writeFileSync(mine, 'my own skill')

    stageSkills(source, 'skill v2')
    installSkills(opts)

    expect(fs.readFileSync(path.join(userData, 'skills', 'weftcut', 'SKILL.md'), 'utf8')).toBe('skill v2')
    expect(fs.readFileSync(mine, 'utf8')).toBe('my own skill')
  })

  it('names the fault so dev-before-build reads differently from a broken install', () => {
    const dev = { resourcesSkills: 'X:\\nope', devSkills: 'X:\\also-nope', isPackaged: false, userDataDir: tmpDir() }
    expect(installSkills(dev)).toEqual({ state: 'unavailable', dir: null, fault: 'not_built' })

    const packaged = { resourcesSkills: 'X:\\nope', devSkills: 'X:\\also-nope', isPackaged: true, userDataDir: tmpDir() }
    expect(installSkills(packaged)).toEqual({ state: 'unavailable', dir: null, fault: 'bundle_missing' })
  })

  it('hands out an earlier launch copy as stale rather than as this version', () => {
    const userData = tmpDir()
    seedUserData(userData, 'skill from a previous launch')
    const got = installSkills({ resourcesSkills: 'X:\\nope', devSkills: 'X:\\nope', isPackaged: true, userDataDir: userData })
    expect(got).toEqual({ state: 'stale', dir: path.join(userData, 'skills'), fault: 'bundle_missing' })
  })

  it('a bundle without the weftcut skill is incomplete, not a healthy install', () => {
    // The trap this closes: copying an empty tree over a previous launch's good
    // copy succeeds and leaves a usable folder behind, so only the source can
    // tell the difference.
    const userData = tmpDir()
    seedUserData(userData, 'skill from a previous launch')
    const empty = tmpDir()
    const got = installSkills({ resourcesSkills: empty, devSkills: 'X:\\nope', isPackaged: true, userDataDir: userData })
    expect(got).toEqual({ state: 'stale', dir: path.join(userData, 'skills'), fault: 'incomplete' })
    expect(fs.readFileSync(path.join(userData, 'skills', 'weftcut', 'SKILL.md'), 'utf8')).toBe('skill from a previous launch')
  })

  it('a folder without SKILL.md does not count as a skill to hand out', () => {
    const userData = tmpDir()
    const source = tmpDir()
    fs.mkdirSync(path.join(source, 'weftcut'), { recursive: true })
    fs.writeFileSync(path.join(source, 'weftcut', 'motif-authoring.md'), 'doc with no skill')
    expect(installSkills({ resourcesSkills: source, devSkills: 'X:\\nope', isPackaged: true, userDataDir: userData })).toEqual({
      state: 'unavailable',
      dir: null,
      fault: 'incomplete',
    })
  })

  it('a destination it cannot write reports copy_failed against whatever is there', () => {
    const userData = tmpDir()
    const source = stageSkills(tmpDir(), 'skill v1')
    // A plain file where the skills directory belongs: cpSync throws, and there
    // is nothing installable underneath it.
    fs.writeFileSync(path.join(userData, 'skills'), 'not a directory')
    expect(installSkills({ resourcesSkills: source, devSkills: 'X:\\nope', isPackaged: true, userDataDir: userData })).toEqual({
      state: 'unavailable',
      dir: null,
      fault: 'copy_failed',
    })
  })
})
