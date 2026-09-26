// What undo / redo and set_project_settings ANSWER with: the op the cursor
// stepped over, by name, and which settings a patch actually changed.
import { describe, it, expect } from 'vitest'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'

function setup() {
  const idGen = uuidV7Gen()
  return createActor({ initial: blankProject(idGen, 'answers'), idGen, clock: () => '<TS>' })
}
const call = (a: ReturnType<typeof setup>, name: string, args: object, client?: string) => {
  const r = a.mcpCall(name, JSON.stringify(args), client)
  if (!r.ok) throw new Error(r.error.message)
  return r.result.structuredContent as Record<string, any>
}

describe('undo / redo name the op they step over', () => {
  it('undo answers with the op it reverted; redo with the op it reapplied', () => {
    const a = setup()
    call(a, 'add_track', { label: 'first' })
    call(a, 'add_track', { label: 'second' }, 'claude-code')
    const undone = call(a, 'undo', {})
    expect(undone.undone).toMatchObject({ summary: 'Added track', entity_labels: [{ text: 'second' }], actor: { kind: 'Agent', client: 'claude-code' } })
    expect(undone.undone.op_id).toBe(a.historyView(10).ops[2].op_id)
    const redone = call(a, 'redo', {})
    expect(redone.redone.op_id).toBe(undone.undone.op_id)
    expect(redone.cursor).toBe(2)
  })
})

describe('set_project_settings reports what changed', () => {
  it('names the field a patch changed', () => {
    const a = setup()
    const before = a.snapshot().settings.prefer_proxies
    expect(call(a, 'set_project_settings', { patch: { prefer_proxies: !before } }).changed).toEqual(['prefer_proxies'])
  })
  it('answers an empty `changed` when every value was already in place', () => {
    const a = setup()
    const current = a.snapshot().settings.prefer_proxies
    const out = call(a, 'set_project_settings', { patch: { prefer_proxies: current } })
    expect(out.changed).toEqual([])
    expect(out.settings.prefer_proxies).toBe(current)
  })
})
