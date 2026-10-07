import { expect, it } from 'vitest'
import { createWorkspaceEventGate } from './workspaceEvents'

it('drops already-queued native writebacks during and after a project transition', () => {
  const gate = createWorkspaceEventGate()
  gate.activate(1)
  const old = { workspace_generation: 1, media_id: 'same-persisted-id' }
  expect(gate.accept(old)).toBe(true)
  gate.beginTransition()
  expect(gate.accept(old)).toBe(false)
  expect(gate.accept({ workspace_generation: 2 })).toBe(false)
  gate.activate(2)
  expect(gate.accept(old)).toBe(false)
  expect(gate.accept({ workspace_generation: 2 })).toBe(true)
  expect(gate.accept({ memory_mib: 100 })).toBe(true)
})
