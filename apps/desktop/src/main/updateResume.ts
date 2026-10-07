import type { UpdateResume } from '../shared/updates.js'

/** A single-update handoff, independent of the user's reopen-on-launch setting. */
export function createUpdateResume(deps: {
  read: () => string | null
  write: (body: string) => void
  clear: () => void
  version: string
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  return {
    save(version: string, path: string | null) {
      deps.write(JSON.stringify({ version, path, createdAt: now() }))
    },
    clear: deps.clear,
    take(): UpdateResume {
      try {
        const body = deps.read()
        if (!body) return null
        const value: unknown = JSON.parse(body)
        if (!value || typeof value !== 'object') throw new Error('Invalid update resume')
        const item = value as Record<string, unknown>
        if (typeof item.createdAt !== 'number' || now() - item.createdAt > 24 * 60 * 60 * 1000
          || item.createdAt > now() || (item.path !== null && typeof item.path !== 'string')) {
          throw new Error('Invalid or expired update resume')
        }
        // A launch of the old version during installation must not consume it.
        if (item.version !== deps.version) return null
        deps.clear()
        return { path: item.path as string | null }
      } catch {
        // This optional handoff must never stop the application from booting.
        try { deps.clear() } catch { /* normal startup is still available */ }
        return null
      }
    },
  }
}
