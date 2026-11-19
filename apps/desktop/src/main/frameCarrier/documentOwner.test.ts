import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { documentOwner } from './documentOwner'

const OWNER_EVENTS = ['destroyed', 'render-process-gone', 'did-start-navigation'] as const

function fakeContents() {
  const emitter = new EventEmitter()
  const listening = () => OWNER_EVENTS.filter(event => emitter.listenerCount(event) > 0)
  return { emitter, contents: emitter as unknown as WebContents, listening }
}

describe('documentOwner', () => {
  it.each([
    ['the contents is destroyed', (e: EventEmitter) => e.emit('destroyed')],
    ['its render process is gone', (e: EventEmitter) => e.emit('render-process-gone', {}, { reason: 'crashed' })],
    ['its main frame loads another document', (e: EventEmitter) => e.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })],
  ])('ends every subscriber once when %s', (_cause, cause) => {
    const { emitter, contents, listening } = fakeContents()
    const a = vi.fn(), b = vi.fn()
    documentOwner(contents).onGone(a)
    documentOwner(contents).onGone(b)
    cause(emitter)
    // A crash is followed by `destroyed`; neither subscriber hears it twice.
    emitter.emit('render-process-gone', {}, { reason: 'crashed' })
    emitter.emit('destroyed')
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
    expect(listening()).toEqual([])
  })

  it('keeps the document through same-document and subframe navigations', () => {
    const { emitter, contents } = fakeContents()
    const gone = vi.fn()
    documentOwner(contents).onGone(gone)
    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    emitter.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(gone).not.toHaveBeenCalled()
  })

  it('stops listening when the last subscriber leaves, and only then', () => {
    const { emitter, contents, listening } = fakeContents()
    const a = vi.fn(), b = vi.fn()
    const leaveA = documentOwner(contents).onGone(a)
    const leaveB = documentOwner(contents).onGone(b)
    leaveA()
    expect(listening()).toEqual(OWNER_EVENTS)
    leaveB()
    expect(listening()).toEqual([])
    emitter.emit('destroyed')
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
  })

  it('the next document is tracked afresh after a navigation', () => {
    const { emitter, contents } = fakeContents()
    const before = vi.fn(), after = vi.fn()
    const leaveBefore = documentOwner(contents).onGone(before)
    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    documentOwner(contents).onGone(after)
    // Leaving after the document went is a no-op; it must not detach the
    // listeners the next document's subscriber relies on.
    leaveBefore()
    emitter.emit('destroyed')
    expect(before).toHaveBeenCalledOnce()
    expect(after).toHaveBeenCalledOnce()
  })

  it('a subscriber that throws does not keep the others from ending', () => {
    const { emitter, contents } = fakeContents()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const later = vi.fn()
    documentOwner(contents).onGone(() => { throw new Error('boom') })
    documentOwner(contents).onGone(later)
    emitter.emit('destroyed')
    expect(later).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
