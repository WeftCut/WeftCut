import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'

const mk = () => { const g = uuidV7Gen(); return createActor({ initial: blankProject(g, 't'), idGen: g, clock: () => '2026-01-01T00:00:00.000Z' }) }

describe('command-path arg hardening', () => {
  it('add_color_layer rejects a non-number tStartUs instead of committing NaN', () => {
    const r = mk().command('add_color_layer', { tStartUs: 'soon', durationUs: 1_000_000 })
    expect(r.ok).toBe(false)
  })
  it('add_color_layer rejects a string color', () => {
    const r = mk().command('add_color_layer', { tStartUs: 0, color: '#fff' })
    expect(r.ok).toBe(false)
  })
})
