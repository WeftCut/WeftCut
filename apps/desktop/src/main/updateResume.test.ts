import { describe, expect, it } from 'vitest'
import { createUpdateResume } from './updateResume'

describe('update project handoff', () => {
  it('falls back to normal startup when the optional handoff cannot be read', () => {
    const fail = () => { throw new Error('Access denied') }
    expect(createUpdateResume({ version: '1.1.0', read: fail, write: fail, clear: fail }).take()).toBeNull()
  })
  function setup() {
    let body: string | null = null
    let now = 1000
    const store = (version: string) => createUpdateResume({ version, now: () => now,
      read: () => body, write: next => { body = next }, clear: () => { body = null } })
    return { store, elapse: (ms: number) => { now += ms } }
  }
  it.each(['/work/Example project', null])('restores the exact workspace %s only once in the target version', path => {
    const { store } = setup()
    store('1.0.0').save('1.1.0', path)
    expect(store('1.0.0').take()).toBeNull()
    expect(store('1.1.0').take()).toEqual({ path })
    expect(store('1.1.0').take()).toBeNull()
  })
  it('does not unexpectedly reopen a stale project long after a failed install', () => {
    const { store, elapse } = setup()
    store('1.0.0').save('1.1.0', '/work/Example')
    elapse(25 * 60 * 60 * 1000)
    expect(store('1.1.0').take()).toBeNull()
  })
  it('clears the handoff when preparation is cancelled', () => {
    const { store } = setup()
    store('1.0.0').save('1.1.0', '/work/Example')
    store('1.0.0').clear()
    expect(store('1.1.0').take()).toBeNull()
  })
})
