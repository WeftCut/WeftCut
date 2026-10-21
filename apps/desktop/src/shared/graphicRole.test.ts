import { describe, it, expect } from 'vitest'
import { BUILTIN_GRAPHIC_ROLES, graphicRoleProblem } from './graphicRole'

describe('graphicRoleProblem', () => {
  it('accepts null, every built-in and any well-formed custom name', () => {
    for (const ok of [null, ...BUILTIN_GRAPHIC_ROLES, 'chapter_card', 'a', 'x2', 'a'.repeat(32)]) expect(graphicRoleProblem(ok)).toBeNull()
  })
  it('refuses a malformed name or a non-string', () => {
    for (const bad of ['', 'Title', 'lower-third', '1st', '_x', 'a b', 'a'.repeat(33), undefined, 3, {}]) {
      expect(graphicRoleProblem(bad)).toMatch(/graphic_role must be null or a lowercase name/)
    }
  })
})
