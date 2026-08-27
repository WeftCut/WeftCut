// apps/desktop/src/main/state/__tests__/serialize.test.ts
import { describe, it, expect } from 'vitest'
import { parseProject } from '../serialize'
import { SCHEMA_VERSION, blankProject } from '../model'
import { seededGen } from '../ids'

describe('parseProject structural conformance', () => {
  const good = structuredClone({ ...blankProject(seededGen(), 'p') })

  it('accepts a well-formed project', () => {
    expect(() => parseProject(good)).not.toThrow()
  })
  it('rejects a non-object', () => {
    expect(() => parseProject(42)).toThrow(/not an object/)
  })
  it('rejects a wrong schema_version', () => {
    expect(() => parseProject({ ...good, schema_version: SCHEMA_VERSION - 1 })).toThrow(/schema_version/)
  })
  it('rejects a project missing required top-level fields', () => {
    // The container is REQUIRED with no default: a flat pre-container file still
    // says schema_version 1 and must fail HERE, not open as an empty project
    // (spec § Cut-over).
    const { compositions, ...noCompositions } = good
    expect(() => parseProject(noCompositions)).toThrow(/compositions/)
    const { root_id, ...noRoot } = good
    expect(() => parseProject(noRoot)).toThrow(/root_id/)
    const { media_pool, ...noPool } = good
    expect(() => parseProject(noPool)).toThrow(/media_pool/)
  })
  it('rejects a root_id that is not a key of compositions', () => {
    expect(() => parseProject({ ...good, root_id: 'ghost' })).toThrow(/root_id ghost is not a key/)
  })
  it('rejects a wrong field type', () => {
    const rootId = good.root_id
    expect(() => parseProject({ ...good, compositions: { [rootId]: { ...good.compositions[rootId], tracks: {} } } })).toThrow(/tracks must be an array/)
    expect(() => parseProject({ ...good, compositions: { [rootId]: 'x' } })).toThrow(/must be an object/)
    expect(() => parseProject({ ...good, compositions: [] })).toThrow(/compositions/)
  })
})
