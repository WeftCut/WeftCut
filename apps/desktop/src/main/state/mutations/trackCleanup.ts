import { AsyncLocalStorage } from 'node:async_hooks'

// A preference belongs to the editing call, never to a Project snapshot. Scope
// it around the whole recipe so nested operations (groups, ripple, forced media
// removal) use the same policy without persisting it or sharing mutable state
// between actors. Direct mutation callers retain the default-on behavior.
const cleanup = new AsyncLocalStorage<boolean>()

export function withTrackCleanup<T>(enabled: boolean, recipe: () => T): T {
  return cleanup.run(enabled, recipe)
}

export function trackCleanupEnabled(): boolean {
  return cleanup.getStore() ?? true
}
