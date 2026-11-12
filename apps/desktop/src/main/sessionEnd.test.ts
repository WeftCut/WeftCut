import { describe, expect, it } from 'vitest'
import { endSession } from './sessionEnd'

/** Deps that log each step; the steps named in `failing` throw. */
function harness(failing: string[] = []) {
  const events: string[] = []
  const step = (name: string) => () => {
    events.push(name)
    if (failing.includes(name)) throw new Error(`${name} failed`)
  }
  const deps = {
    save: step('save'),
    flush: [step('layout'), step('geometry')],
    diagnostics: {
      record: (kind: string, message: string) => { events.push(`record:${kind}:${message.split('\n')[0]}`) },
      failure: (kind: string, message: string) => { events.push(`failure:${kind}:${message.split('\n')[0]}`) },
      close: () => { events.push('close') },
    },
  }
  return { deps, events }
}

describe('endSession', () => {
  it('saves, settles the debounced writes and closes the session, all before returning', () => {
    const { deps, events } = harness()
    endSession(['shutdown'], deps)
    expect(events).toEqual(['record:session-end:shutdown', 'save', 'layout', 'geometry', 'close'])
  })

  it('names every reason the OS gave', () => {
    const { deps, events } = harness()
    endSession(['close-app', 'logoff'], deps)
    expect(events[0]).toBe('record:session-end:close-app,logoff')
  })

  it('a failed save is reported by the next start, and the rest still runs', () => {
    const { deps, events } = harness(['save'])
    endSession(['shutdown'], deps)
    expect(events).toEqual([
      'record:session-end:shutdown', 'save', 'failure:session-end-save:Error: save failed',
      'layout', 'geometry', 'close',
    ])
  })

  it('a failed layout write costs neither the other write nor the report of an orderly end', () => {
    const { deps, events } = harness(['layout'])
    endSession(['logoff'], deps)
    expect(events).toEqual([
      'record:session-end:logoff', 'save', 'layout', 'record:session-end-flush:Error: layout failed',
      'geometry', 'close',
    ])
    expect(events.some(e => e.startsWith('failure:'))).toBe(false)
  })
})
