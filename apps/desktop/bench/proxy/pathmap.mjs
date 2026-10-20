// apps/desktop/bench/proxy/pathmap.mjs
//
// Path rewriting for the remote-host MCP proxy (proxy.ts). The agent works in
// a LOCAL directory and names files there; the app runs on another machine and
// can only open the mirror of that directory on its own disk. So:
//
//   toRemote: an argument string that IS a path inside the local workdir
//             becomes the same path under the remote mirror (Windows form).
//             Absolute paths outside the workdir pass through untouched and
//             are reported, so a log shows what the app was asked to open.
//   toLocal:  every occurrence of the remote mirror root inside a result
//             string — whole or embedded in text, raw or JSON-escaped — goes
//             back to the local path, so the agent never sees the mirror.
//
// Known limit: back to local, a path ends at whitespace — in prose there is no
// telling `…\work\m1 as draft` from a folder named `m1 as draft`. Agents name
// their folders; kebab-case ones round-trip.
//
// Pure functions over JSON values; each returns the rewritten value plus the
// list of rewrites it made (the proxy logs them).

/** @typedef {{ dir: 'to-remote' | 'to-local', from: string, to: string }} Rewrite */
/** @typedef {{ kind: 'outside', value: string }} Outside */

/** Characters that can continue a path segment in prose. Excludes separators,
 *  whitespace, quotes and punctuation that usually closes a path in text. */
const SEG = String.raw`[^\\/\s"'<>|*?:,;()\[\]{}]`

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @param {{ localRoot: string, remoteRoot: string }} roots
 *   localRoot: absolute POSIX directory. remoteRoot: absolute Windows directory.
 */
export function createPathMap({ localRoot, remoteRoot }) {
  if (!localRoot.startsWith('/')) throw new Error(`localRoot must be an absolute POSIX path: ${localRoot}`)
  if (!/^[A-Za-z]:\\/.test(remoteRoot)) throw new Error(`remoteRoot must be an absolute Windows path: ${remoteRoot}`)
  const local = localRoot.replace(/\/+$/, '')
  const remote = remoteRoot.replace(/\\+$/, '')

  /** One string, local → remote. Returns null when it is not a workdir path. */
  function mapToRemote(s) {
    if (s === local || s === `${local}/`) return remote
    if (!s.startsWith(`${local}/`)) return null
    const parts = s.slice(local.length + 1).split('/').filter((p) => p !== '' && p !== '.')
    // `..` could climb out of the workdir: not a workdir path then.
    if (parts.includes('..')) return null
    return parts.length ? `${remote}\\${parts.join('\\')}` : remote
  }

  // The remote root as it may appear in a result: any mix of `\`, `\\` (JSON
  // escaped) or `/` between its segments, any case (Windows paths are).
  const rootSegs = remote.split('\\').map(escapeRe)
  const SEP = String.raw`(?:\\\\|\\|/)`
  const remoteRe = new RegExp(
    `${rootSegs.join(SEP)}((?:${SEP}${SEG}+)*)${SEP}?(?!${SEG})`,
    'gi',
  )

  /** One string, remote → local, every occurrence. */
  function mapToLocal(s) {
    remoteRe.lastIndex = 0
    if (!remoteRe.test(s)) return null
    remoteRe.lastIndex = 0
    return s.replace(remoteRe, (_m, rest) => local + rest.replace(/\\\\|\\|\//g, '/'))
  }

  /** Deep-walk `value`, applying `fn` to strings (not to object keys). */
  function walk(value, fn) {
    if (typeof value === 'string') return fn(value)
    if (Array.isArray(value)) return value.map((v) => walk(v, fn))
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, fn)
      return out
    }
    return value
  }

  return {
    local,
    remote,
    /** @returns {{ value: unknown, rewrites: Rewrite[], outside: Outside[] }} */
    toRemote(value) {
      /** @type {Rewrite[]} */ const rewrites = []
      /** @type {Outside[]} */ const outside = []
      const out = walk(value, (s) => {
        const mapped = mapToRemote(s)
        if (mapped !== null) {
          rewrites.push({ dir: 'to-remote', from: s, to: mapped })
          return mapped
        }
        // An absolute POSIX path the agent named outside its workdir: the app
        // cannot open it, but that is the agent's call to make. Logged.
        if (/^\/[^\s]*[^\s/]$/.test(s) && s.includes('/', 1)) outside.push({ kind: 'outside', value: s })
        return s
      })
      return { value: out, rewrites, outside }
    },
    /** @returns {{ value: unknown, rewrites: Rewrite[] }} */
    toLocal(value) {
      /** @type {Rewrite[]} */ const rewrites = []
      const out = walk(value, (s) => {
        const mapped = mapToLocal(s)
        if (mapped === null) return s
        rewrites.push({ dir: 'to-local', from: s.length > 300 ? `${s.slice(0, 300)}…` : s, to: mapped.length > 300 ? `${mapped.slice(0, 300)}…` : mapped })
        return mapped
      })
      return { value: out, rewrites }
    },
  }
}
