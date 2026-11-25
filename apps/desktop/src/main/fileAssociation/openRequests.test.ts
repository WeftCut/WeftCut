import { EventEmitter } from 'node:events'
import type { App } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { openHandoff } from './openTarget.js'
import { createOpenRequestInbox, receiveOpenRequests } from './openRequests.js'

describe('open request inbox', () => {
  it('keeps the latest request: the one the user asked for last', () => {
    const inbox = createOpenRequestInbox()
    inbox.offer('/home/u/a.wcpr')
    inbox.offer('/home/u/b.wcpk')
    expect(inbox.take()).toBe('/home/u/b.wcpk')
  })

  it('hands a request out once', () => {
    const inbox = createOpenRequestInbox()
    inbox.offer('/home/u/a.wcpr')
    expect(inbox.take()).toBe('/home/u/a.wcpr')
    expect(inbox.pending()).toBe(false)
    expect(inbox.take()).toBeNull()
  })

  it('reports a waiting request without taking it', () => {
    const inbox = createOpenRequestInbox()
    expect(inbox.pending()).toBe(false)
    inbox.offer('/home/u/a.wcpr')
    expect(inbox.pending()).toBe(true)
    expect(inbox.pending()).toBe(true)
    expect(inbox.take()).toBe('/home/u/a.wcpr')
  })

  it('ignores an empty offer: it neither notifies nor erases a waiting request', () => {
    const inbox = createOpenRequestInbox()
    const listener = vi.fn()
    inbox.subscribe(listener)
    inbox.offer(null)
    expect(listener).not.toHaveBeenCalled()
    expect(inbox.pending()).toBe(false)
    inbox.offer('/home/u/a.wcpr')
    inbox.offer(null)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(inbox.take()).toBe('/home/u/a.wcpr')
  })

  it('notifies every subscriber of each offer until it unsubscribes', () => {
    const inbox = createOpenRequestInbox()
    const kept = vi.fn()
    const dropped = vi.fn()
    inbox.subscribe(kept)
    const unsubscribe = inbox.subscribe(dropped)
    inbox.offer('/home/u/a.wcpr')
    unsubscribe()
    inbox.offer('/home/u/b.wcpk')
    expect(kept).toHaveBeenCalledTimes(2)
    expect(dropped).toHaveBeenCalledTimes(1)
  })
})

describe('receiveOpenRequests', () => {
  function setup(argv: string[] = ['/opt/WeftCut/weftcut']) {
    const app = new EventEmitter()
    const inbox = createOpenRequestInbox()
    receiveOpenRequests(app as unknown as Pick<App, 'on'>, { argv, cwd: '/home/u', platform: 'linux' }, inbox)
    return { app, inbox }
  }

  it('offers the launch\'s own target before any event arrives', () => {
    const { inbox } = setup(['/opt/WeftCut/weftcut', '/home/u/Trip/project.wcpr'])
    expect(inbox.take()).toBe('/home/u/Trip/project.wcpr')
  })

  it('offers nothing for a launch that names no file', () => {
    expect(setup().inbox.pending()).toBe(false)
  })

  it('takes over a macOS open-file and offers an owned file', () => {
    const { app, inbox } = setup()
    const event = { preventDefault: vi.fn() }
    app.emit('open-file', event, '/home/u/Trip/trip.wcpk')
    expect(event.preventDefault).toHaveBeenCalled()
    expect(inbox.take()).toBe('/home/u/Trip/trip.wcpk')
  })

  it('offers nothing for an open-file of a type WeftCut does not own', () => {
    const { app, inbox } = setup()
    app.emit('open-file', { preventDefault: vi.fn() }, '/home/u/clip.mp4')
    expect(inbox.pending()).toBe(false)
  })

  it('offers the target a second launch hands over', () => {
    const { app, inbox } = setup()
    app.emit('second-instance', {}, ['/opt/WeftCut/weftcut'], '/home/u', openHandoff('/home/u/Trip/project.wcpr'))
    expect(inbox.take()).toBe('/home/u/Trip/project.wcpr')
  })

  it.each([
    ['no handoff', undefined],
    ['a relative path', { open: 'Trip/project.wcpr' }],
    ['a type WeftCut does not own', { open: '/home/u/clip.mp4' }],
  ])('offers nothing for a second launch with %s', (_label, data) => {
    const { app, inbox } = setup()
    // The argv names a target, but only the handoff counts: Chromium has parsed the argv.
    app.emit('second-instance', {}, ['/opt/WeftCut/weftcut', '/home/u/Trip/project.wcpr'], '/home/u', data)
    expect(inbox.pending()).toBe(false)
  })
})
