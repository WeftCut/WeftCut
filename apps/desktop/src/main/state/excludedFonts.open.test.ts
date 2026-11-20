// `settings.excluded_fonts` is an additive field: no schema step writes it,
// the open's version-blind normalize pass (`parseProject`) fills and repairs it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadProjectFromJson, serializeProjectToJson } from './persistence'
import { SCHEMA_VERSION } from './model'
import { validate } from './validate'

const DIR = '/home/u/Film'

/** The current fixture with `excluded_fonts` set to `list`, or without it
 *  when `list` is undefined. */
function projectJson(list: unknown): string {
  const wire = JSON.parse(readFileSync(`fixtures/projects/v${SCHEMA_VERSION}.json`, 'utf8')) as { settings: Record<string, unknown> }
  if (list === undefined) delete wire.settings.excluded_fonts
  else wire.settings.excluded_fonts = list
  return JSON.stringify(wire, null, 2)
}

const open = (text: string) => loadProjectFromJson(text, { dir: DIR }).project

describe('opening settings.excluded_fonts', () => {
  it('opens a project written before the field as excluding nothing', () => {
    const project = open(projectJson(undefined))
    expect(project.settings.excluded_fonts).toEqual([])
    expect(() => validate(project)).not.toThrow()
  })

  it('keeps a valid list as it is', () => {
    expect(open(projectJson(['Example Serif', 'Lora'])).settings.excluded_fonts).toEqual(['Example Serif', 'Lora'])
  })

  it('repairs the entries validate refuses rather than refusing the open', () => {
    const project = open(projectJson([' Example Serif ', 'example serif', '', 42, 'Lora']))
    expect(project.settings.excluded_fonts).toEqual(['Example Serif', 'Lora'])
    expect(() => validate(project)).not.toThrow()
  })

  it('reads a value that is not a list as excluding nothing', () => {
    expect(open(projectJson('Example Serif')).settings.excluded_fonts).toEqual([])
  })

  it('saves the list and reopens it unchanged', () => {
    const saved = serializeProjectToJson(open(projectJson(['Example Serif'])))
    const reopened = loadProjectFromJson(saved, { dir: DIR })
    expect(reopened.upgradedFrom).toBeNull()
    expect(reopened.project.settings.excluded_fonts).toEqual(['Example Serif'])
    expect(serializeProjectToJson(reopened.project)).toBe(saved)
  })
})
