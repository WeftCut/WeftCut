import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LINEAGE_FILE, MotifLineage, isLineageUid } from './lineage'

const roots: string[] = []
function temp() { const root = mkdtempSync(path.join(tmpdir(), 'motif-lineage-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('MotifLineage', () => {
  it('mints a lineage once per package and keeps it across launches', () => {
    const file = path.join(temp(), LINEAGE_FILE)
    const record = new MotifLineage(file)
    const uid = record.of('card')
    expect(isLineageUid(uid)).toBe(true)
    expect(record.of('card')).toBe(uid)
    expect(record.of('drafts/card-draft')).not.toBe(uid)
    expect(new MotifLineage(file).peek('card')).toBe(uid)
  })

  it('moves, forgets and names the holders of a lineage', () => {
    const record = new MotifLineage(path.join(temp(), LINEAGE_FILE))
    const uid = record.of('drafts/card')
    record.set('card', uid)
    expect(record.holders(uid).sort()).toEqual(['card', 'drafts/card'])
    record.move('drafts/card', 'drafts/card-draft')
    expect(record.peek('drafts/card')).toBeNull()
    expect(record.holders(uid).sort()).toEqual(['card', 'drafts/card-draft'])
    record.forget('card', 'drafts/card-draft')
    expect(record.holders(uid)).toEqual([])
    expect(() => record.set('card', 'not-a-uid')).toThrow(/lineage/)
  })

  it('sets an unreadable record aside instead of writing over it', () => {
    const root = temp(), file = path.join(root, LINEAGE_FILE)
    writeFileSync(file, '{ not json')
    const record = new MotifLineage(file)
    record.of('card')
    const aside = readdirSync(root).filter(name => name.startsWith(`${LINEAGE_FILE}.unreadable-`))
    expect(aside).toHaveLength(1)
    expect(readFileSync(path.join(root, aside[0]!), 'utf8')).toBe('{ not json')
    expect(existsSync(file)).toBe(true)
  })
})
