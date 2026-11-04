import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configureSkillBundle, isSkillUri, readSkillResource, readSkillView, skillResourceDefs } from './skillResources'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-skill-'))
const skill = path.join(root, 'weftcut')

beforeAll(() => {
  fs.mkdirSync(path.join(skill, 'craft'), { recursive: true })
  fs.mkdirSync(path.join(skill, 'templates'))
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: weftcut\ndescription: Drive the editor.\nmetadata:\n  version: \'1.2.3\'\n---\n# Body\n')
  fs.writeFileSync(path.join(skill, 'craft', 'rules.md'), 'rules\n')
  fs.writeFileSync(path.join(skill, 'templates', 'x.zip'), Buffer.from([0x50, 0x4b, 0xff]))
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside the skill')
})
afterAll(() => {
  configureSkillBundle(path.join(root, 'gone'))
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the served skill', () => {
  it('lists the entry alone, named and described from its frontmatter', () => {
    configureSkillBundle(root)
    expect(skillResourceDefs()).toEqual([{ uri: 'skill://weftcut/SKILL.md', name: 'weftcut', description: 'Drive the editor.', mimeType: 'text/markdown' }])
  })

  it('reads the entry and the files beside it, text as text and binary as a blob', () => {
    configureSkillBundle(root)
    expect(readSkillResource('skill://weftcut/SKILL.md').contents[0]).toMatchObject({ mimeType: 'text/markdown', text: expect.stringContaining('# Body') })
    expect(readSkillResource('skill://weftcut/craft/rules.md').contents[0]).toMatchObject({ uri: 'skill://weftcut/craft/rules.md', text: 'rules\n' })
    expect(readSkillResource('skill://weftcut/templates/x.zip').contents[0]).toEqual({ uri: 'skill://weftcut/templates/x.zip', mimeType: 'application/zip', blob: Buffer.from([0x50, 0x4b, 0xff]).toString('base64') })
  })

  it.each(['skill://weftcut/../secret.txt', 'skill://weftcut/craft/../../secret.txt', 'skill://weftcut/%2e%2e/secret.txt', 'skill://weftcut//etc/passwd', 'skill://weftcut/craft', 'skill://other/SKILL.md'])(
    'answers not-found for %s, without touching the filesystem outside the skill', (uri) => {
      configureSkillBundle(root)
      expect(isSkillUri(uri)).toBe(true)
      let error: { code?: number; message?: string } | undefined
      try { readSkillResource(uri) } catch (e) { error = e as typeof error }
      expect(error?.code).toBe(-32002)
      expect(error?.message).toContain('SKILL.md')
      expect(error?.message).not.toContain('outside the skill')
    })

  it('the view answers text, and refuses a path outside the skill or a binary by name', () => {
    configureSkillBundle(root)
    expect(readSkillView('craft/rules.md')).toEqual({ content: [{ type: 'text', text: 'rules\n' }] })
    expect(() => readSkillView('../secret.txt')).toThrow(/not a file of the weftcut skill/)
    expect(() => readSkillView('templates/x.zip')).toThrow(/binary/)
  })

  it('a missing bundle lists nothing and says so, and is found once built', () => {
    const later = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-skill-later-'))
    configureSkillBundle(later)
    expect(skillResourceDefs()).toEqual([])
    expect(() => readSkillResource('skill://weftcut/SKILL.md')).toThrow(/build:skills/)
    expect(() => readSkillView('SKILL.md')).toThrow(/build:skills/)
    fs.mkdirSync(path.join(later, 'weftcut'))
    fs.writeFileSync(path.join(later, 'weftcut', 'SKILL.md'), '---\nname: weftcut\ndescription: d\n---\n')
    expect(skillResourceDefs()).toHaveLength(1)
    fs.rmSync(later, { recursive: true, force: true })
  })
})
