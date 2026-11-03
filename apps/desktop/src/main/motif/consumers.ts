/** Motif work belongs to a renderer document, not its long-lived WebContents.
 * `retire` runs when that document goes away (navigation, reload, crash or
 * destroy) and closes what it held: texture leases and its reader port. */
export function createMotifConsumers(retire: (owner: Electron.WebContents) => void) {
  const consumers = new WeakMap<Electron.WebContents, { document: object | null }>()
  return (owner: Electron.WebContents, frame: Electron.WebFrameMain | null): (() => boolean) => {
    let consumer = consumers.get(owner)
    if (!consumer) {
      consumer = { document: {} }
      consumers.set(owner, consumer)
      const state = consumer
      // A reload must cancel old work and re-import pools for the
      // replacement preload.
      owner.on('did-start-navigation', details => {
        if (details.isMainFrame && !details.isSameDocument) {
          state.document = null
          retire(owner)
        }
      })
      owner.on('dom-ready', () => { state.document = {} })
      // A cancelled/failed navigation can leave the original document usable.
      owner.on('did-stop-loading', () => { state.document ??= {} })
      owner.on('render-process-gone', () => { state.document = null; retire(owner) })
      owner.once('destroyed', () => { state.document = null; retire(owner) })
    }
    const document = consumer.document
    // Bind at IPC admission, BEFORE async disk reads/capture. Work from the
    // outgoing document must not acquire leases in the replacement document.
    return () => document !== null && consumer.document === document && !owner.isDestroyed() && frame !== null && !frame.detached
  }
}
