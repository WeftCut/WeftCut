/** Prevent reentrant window-all-closed quits from interrupting the async flush. */
export function createQuitFlush(deps: {
  destroyRenderer: () => void
  flush: () => Promise<void>
  quit: () => void
  onError: (error: unknown) => void
}) {
  let pending = false
  let flushed = false
  return (event: {preventDefault:()=>void}): void => {
    if (flushed) return
    event.preventDefault()
    if (pending) return
    pending = true
    // Mark pending before destroy: its window-all-closed event can synchronously
    // reenter before-quit. The renderer's worker is then absent during cleanup.
    deps.destroyRenderer()
    void deps.flush().catch(deps.onError).finally(() => { flushed = true; deps.quit() })
  }
}
