import { describe, expect, it, vi } from 'vitest'
import { QUIT_SAVE_CHOICES, quitSaveDialog, settleQuitSave, type QuitSaveChoice } from './quitSave'

/** A save that fails `failures` times, then succeeds; answers come from `answers`. */
function harness(failures: number, answers: QuitSaveChoice[], unsaved = true) {
  const events: string[] = []
  let left = failures
  const deps = {
    save: vi.fn(async () => {
      events.push('save')
      if (left > 0) { left--; throw new Error('ENOSPC: no space left on device') }
    }),
    unsaved: () => unsaved,
    ask: vi.fn(async () => { const a = answers.shift()!; events.push(`ask:${a}`); return a }),
    discard: vi.fn(() => { events.push('discard') }),
  }
  return { deps, events }
}

describe('settleQuitSave', () => {
  it('quits without asking when the save succeeds', async () => {
    const { deps, events } = harness(0, [])
    await expect(settleQuitSave(deps)).resolves.toBe(true)
    expect(events).toEqual(['save'])
  })

  it('Retry saves again, as often as asked, and quits once a save lands', async () => {
    const { deps, events } = harness(2, ['retry', 'retry'])
    await expect(settleQuitSave(deps)).resolves.toBe(true)
    expect(events).toEqual(['save', 'ask:retry', 'save', 'ask:retry', 'save'])
  })

  it('Quit without saving closes the project with nothing more written', async () => {
    const { deps, events } = harness(Infinity, ['discard'])
    await expect(settleQuitSave(deps)).resolves.toBe(true)
    expect(events).toEqual(['save', 'ask:discard', 'discard'])
  })

  it('Cancel stays, and a later quit asks again from the start', async () => {
    const { deps, events } = harness(2, ['cancel', 'retry'])
    await expect(settleQuitSave(deps)).resolves.toBe(false)
    expect(deps.discard).not.toHaveBeenCalled()
    await expect(settleQuitSave(deps)).resolves.toBe(true)
    expect(events).toEqual(['save', 'ask:cancel', 'save', 'ask:retry', 'save'])
  })

  it('a failure with nothing unsaved quits without asking', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { deps, events } = harness(1, [], false)
      await expect(settleQuitSave(deps)).resolves.toBe(true)
      expect(events).toEqual(['save'])
    } finally { warn.mockRestore() }
  })
})

describe('quitSaveDialog', () => {
  it.each([false, true])('offers the three choices in QUIT_SAVE_CHOICES order (zh: %s), Retry default, Cancel on Escape', (zh) => {
    const d = quitSaveDialog(zh, new Error('EACCES: permission denied'))
    expect(d.buttons).toHaveLength(QUIT_SAVE_CHOICES.length)
    expect(QUIT_SAVE_CHOICES[d.defaultId]).toBe('retry')
    expect(QUIT_SAVE_CHOICES[d.cancelId]).toBe('cancel')
    expect(d.detail).toContain('EACCES: permission denied')
  })
})
