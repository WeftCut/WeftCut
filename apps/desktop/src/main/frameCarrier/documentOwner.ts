// Ties main-process work to the renderer document that asked for it, so the
// work ends when that document does.

import type { WebContents } from 'electron'

/** The document currently loaded in one `WebContents`. */
export interface DocumentOwner {
  /** Runs `gone` once when the document goes away: the contents is destroyed,
   * its render process is gone, or its main frame starts loading another
   * document (reload included). Returns the unsubscribe; calling it after
   * `gone` ran is a no-op. */
  onGone(gone: () => void): () => void
}

interface Tracked {
  callbacks: Set<() => void>
  detach: () => void
}

const tracked = new WeakMap<WebContents, Tracked>()

export function documentOwner(contents: WebContents): DocumentOwner {
  return {
    onGone(gone) {
      const entry = tracked.get(contents) ?? track(contents)
      entry.callbacks.add(gone)
      return () => {
        if (!entry.callbacks.delete(gone) || entry.callbacks.size) return
        entry.detach()
      }
    },
  }
}

// One listener set per contents however many subscribers it has; it goes when
// the last subscriber does, so a long-lived window gathers no listeners.
function track(contents: WebContents): Tracked {
  const fire = () => {
    const callbacks = [...entry.callbacks]
    entry.callbacks.clear()
    entry.detach()
    for (const gone of callbacks) {
      try { gone() }
      catch (error) { console.warn('[main] document owner cleanup failed', error) }
    }
  }
  const navigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) fire()
  }
  const entry: Tracked = {
    callbacks: new Set(),
    detach: () => {
      tracked.delete(contents)
      contents.removeListener('destroyed', fire)
      contents.removeListener('render-process-gone', fire)
      contents.removeListener('did-start-navigation', navigation)
    },
  }
  tracked.set(contents, entry)
  contents.once('destroyed', fire)
  contents.once('render-process-gone', fire)
  contents.on('did-start-navigation', navigation)
  return entry
}
