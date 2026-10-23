import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CRAFT_RULES, effectiveThreshold, renderCraftRules } from '../../shared/craft'

const DOC = path.join(import.meta.dirname, '../../../../../skills/weftcut/craft/rules.md')

describe('the craft table', () => {
  it('ships as skills/weftcut/craft/rules.md (UPDATE_CRAFT=1 rewrites it)', () => {
    if (process.env.UPDATE_CRAFT) writeFileSync(DOC, renderCraftRules())
    expect(readFileSync(DOC, 'utf8')).toBe(renderCraftRules())
  })

  it('has unique ids, and a direction wherever it has a number', () => {
    expect(new Set(CRAFT_RULES.map((r) => r.id)).size).toBe(CRAFT_RULES.length)
    for (const r of CRAFT_RULES) expect(r.threshold === undefined || r.direction !== undefined, r.id).toBe(true)
  })

  it('lets a floor tighten a threshold and never loosen it', () => {
    const min = CRAFT_RULES.find((r) => r.id === 'title-hold')!, max = CRAFT_RULES.find((r) => r.id === 'caption-line-length')!
    expect(effectiveThreshold(min, 4)).toBe(4)
    expect(effectiveThreshold(min, 1)).toBe(3)
    expect(effectiveThreshold(max, 32)).toBe(32)
    expect(effectiveThreshold(max, 80)).toBe(42)
  })
})
