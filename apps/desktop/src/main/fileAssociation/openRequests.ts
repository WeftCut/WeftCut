// The inbox between the OS and the window for files to open (ADR 0181).
// `receiveOpenRequests` fills it from the three ways a request arrives; the
// window empties it (`fileOpen:take`), so a request made before the window
// listens is kept rather than lost. The window can only take: no path reaches
// the inbox from the renderer.
import type { App } from 'electron'
import { isOpenTarget, openTargetFromArgv, openTargetFromHandoff } from './openTarget.js'

export interface OpenRequestInbox {
  /** A newer request replaces one not taken yet: the user asked for it last. */
  offer(target: string | null): void
  /** Whether a request waits, without taking it. */
  pending(): boolean
  /** The waiting request, which leaves the inbox. */
  take(): string | null
  /** `listener` runs on every request offered. */
  subscribe(listener: () => void): () => void
}

export function createOpenRequestInbox(): OpenRequestInbox {
  let waiting: string | null = null
  const listeners = new Set<() => void>()
  return {
    offer(target) {
      if (target === null) return
      waiting = target
      for (const listener of listeners) listener()
    },
    pending: () => waiting !== null,
    take() {
      const target = waiting
      waiting = null
      return target
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const openRequests: OpenRequestInbox = createOpenRequestInbox()

/** Feeds `inbox` from the launch's own command line (Windows and Linux), from
 *  a second launch's handoff, and from macOS `open-file`, which reaches the
 *  running app instead of starting another.
 *
 *  LANDMINE: macOS sends the `open-file` of a cold start before `ready`, so
 *  this runs in entry.ts before its first await; registered after it, the
 *  file that launched the app is dropped. */
export function receiveOpenRequests(
  app: Pick<App, 'on'>,
  launch: { argv: readonly string[]; cwd: string; platform: NodeJS.Platform },
  inbox: OpenRequestInbox = openRequests,
): void {
  inbox.offer(openTargetFromArgv(launch.argv, launch.cwd, launch.platform))
  app.on('open-file', (event, file) => {
    event.preventDefault()
    inbox.offer(isOpenTarget(file, launch.platform) ? file : null)
  })
  app.on('second-instance', (_event, _argv, _cwd, data) => inbox.offer(openTargetFromHandoff(data, launch.platform)))
}
