// apps/desktop/src/main/state/model.test.ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, SCHEMA_VERSION } from './model'
import { root } from './__tests__/fixtures/project'

describe('blankProject', () => {
  it('mirrors Rust new_blank: A-roll, B-roll, project_id, then the root composition', () => {
    const p = blankProject(seededGen(), 'test')
    expect(p.schema_version).toBe(SCHEMA_VERSION)
    expect(root(p).tracks).toHaveLength(2)
    expect(root(p).tracks[0].id).toBe('00000000-0000-0000-0000-000000000001')
    expect(root(p).tracks[0].role).toBe('ARoll')
    expect(root(p).tracks[0].removable).toBe(false)
    expect(root(p).tracks[1].id).toBe('00000000-0000-0000-0000-000000000002')
    expect(root(p).tracks[1].role).toBe('BRoll')
    expect(p.project_id).toBe('00000000-0000-0000-0000-000000000003')
    expect(p.root_id).toBe('00000000-0000-0000-0000-000000000004')
    expect(Object.keys(p.compositions)).toEqual([p.root_id])
    expect(root(p).id).toBe(p.root_id)
    expect(root(p).label).toBeNull()
    expect(p.media_pool).toEqual({})
    expect(p.settings.history_capacity).toBe(200)
  })
})
