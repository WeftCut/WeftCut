import { describe, expect, it } from 'vitest'
import { createActor } from '../actor'
import { seededGen } from '../ids'
import { blankProject } from '../model'

function blankActor() {
  const idGen = seededGen()
  return createActor({ initial: blankProject(idGen, 'Excluded fonts'), idGen })
}

describe('setExcludedFonts', () => {
  it('writes a normalized list: trimmed, first spelling of a family kept', () => {
    const actor = blankActor()
    actor.setExcludedFonts([' Example Serif ', 'example serif', 'Brand Sans'])
    expect(actor.snapshot().settings.excluded_fonts).toEqual(['Example Serif', 'Brand Sans'])
  })

  it('is project setup, not an edit: undo takes back the edit before it and keeps the list', () => {
    const actor = blankActor()
    const blank = actor.snapshot().compositions
    expect(actor.dispatch('add_track', {}).ok).toBe(true)
    actor.setExcludedFonts(['Example Serif'])

    expect(actor.dispatch('undo', {}).ok).toBe(true)
    expect(actor.snapshot().compositions).toEqual(blank)
    expect(actor.snapshot().settings.excluded_fonts).toEqual(['Example Serif'])
  })
})
