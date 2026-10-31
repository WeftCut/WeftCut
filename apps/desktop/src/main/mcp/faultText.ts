// apps/desktop/src/main/mcp/faultText.ts
//
// Foreign failure text, said in the error model's words. Three kinds of text
// reach a tool result from below the MCP layer and mean nothing to an agent:
//
// - Electron's wrapper around a rejected `ipcRenderer.invoke`
//   (`Error invoking remote method 'resources:plan-export': Error: …`), which
//   names an internal channel. A render or an export failure the renderer
//   reports back carries it.
// - Node's errno text (`ENOENT: no such file or directory, open '…'`), from a
//   file write such as `export_motif { path }`.
// - The resource admission refusal (`resource-capacity-exceeded: {json}` or the
//   native sentence after the tag), which is a busy budget, not a crash.
//
// `describeFault` rewrites all three into a sentence and names the variant, so
// `toolErrorResult` (every refusal) and the export records (a failed job's
// `error.message`) answer in one vocabulary. Text that is none of these comes
// back unchanged.
import { RESOURCE_CAPACITY_EXCEEDED } from '../../shared/resource-policy'
import type { McpErrorCode } from '../state/mcp-commands'

export interface Fault {
  message: string
  /** The variant, when the text was one of the families above. */
  error?: string
  /** The code the family implies, for a route that has not decided one. */
  code?: McpErrorCode
  data?: Record<string, unknown>
}

const IPC_PREFIX = /Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/g
/** `ENOENT: no such file or directory, open '/x/y.zip'` (and `-> '…'` for a
 *  rename or a copy). The description is Node's; the code and path are what
 *  the sentence is built from. */
const ERRNO = /\b(E[A-Z]{3,}): ([^,]+), ([a-z]+)(?: '([^']*)')?(?: -> '[^']*')?/
const WRITE_SYSCALLS = new Set(['open', 'write', 'mkdir', 'rename', 'copyfile', 'symlink', 'link'])

function errnoFault(code: string, syscall: string, path: string | undefined, description: string): Fault {
  const at = path ?? 'the path'
  const data = { errno: code, ...(path ? { path } : {}) }
  switch (code) {
    case 'ENOENT':
      return { error: 'PathNotFound', code: 'invalid_params', data, message: WRITE_SYSCALLS.has(syscall)
        ? `${at} cannot be written: no file or folder by that name, and a file is only written into a folder that already exists — create the folder first or choose another path`
        : `${at} does not exist — check the path` }
    case 'EEXIST': return { error: 'PathExists', code: 'invalid_params', data, message: `${at} already exists; nothing is overwritten — choose another path` }
    case 'EACCES': case 'EPERM': return { error: 'PermissionDenied', code: 'invalid_params', data, message: `the app may not ${syscall === 'open' ? 'open' : syscall} ${at} (permission denied) — choose a path the app can write` }
    case 'EISDIR': return { error: 'IsADirectory', code: 'invalid_params', data, message: `${at} is a folder; name a file inside it` }
    case 'ENOTDIR': return { error: 'NotADirectory', code: 'invalid_params', data, message: `a part of ${at} is a file, not a folder — check the path` }
    case 'ENOSPC': return { error: 'DiskFull', code: 'invalid_request', data, message: `the disk holding ${at} is full; free space or choose another disk` }
    default: return { error: 'FileSystemError', code: 'internal', data, message: `the file system refused to ${syscall} ${at}: ${description}` }
  }
}

const REASON_TEXT: Record<string, string> = {
  busy: 'other work (an export, a proxy build, a transcription or a render) holds the rest of the budget — retry when it finishes',
  pressure: 'the app is under memory pressure — retry in a few seconds',
  'host-pressure': 'the computer is low on free memory — close other programs or retry later',
  'budget-too-small': 'that is more than the whole budget — a larger memory target in Settings › Performance lets it run',
}

function resourceFault(after: string): Fault {
  const body = after.trim()
  if (body.startsWith('{')) {
    try {
      const b = JSON.parse(body) as { reason?: string; requestedMiB?: number; availableMiB?: number; workMiB?: number }
      const reason = typeof b.reason === 'string' ? b.reason : 'busy'
      return {
        error: 'ResourceBusy', code: 'invalid_request',
        data: { reason, requested_mib: b.requestedMiB ?? null, available_mib: b.availableMiB ?? null, budget_mib: b.workMiB ?? null },
        message: `not enough processing memory right now: this needs about ${b.requestedMiB ?? '?'} MiB and ${b.availableMiB ?? '?'} MiB of the ${b.workMiB ?? '?'} MiB budget is free; ${REASON_TEXT[reason] ?? REASON_TEXT.busy}`,
      }
    } catch { /* not the JSON block: the native sentence path below */ }
  }
  return { error: 'ResourceBusy', code: 'invalid_request', data: {}, message: `not enough processing resources right now: ${body || 'the budget is held'}` }
}

/** The sentence and variant for a failure's raw text. */
export function describeFault(raw: string): Fault {
  const text = raw.replace(IPC_PREFIX, '')
  const tag = text.indexOf(`${RESOURCE_CAPACITY_EXCEEDED}:`)
  if (tag !== -1) {
    const f = resourceFault(text.slice(tag + RESOURCE_CAPACITY_EXCEEDED.length + 1))
    return { ...f, message: text.slice(0, tag) + f.message }
  }
  const m = ERRNO.exec(text)
  if (m) {
    const f = errnoFault(m[1]!, m[3]!, m[4], m[2]!)
    return { ...f, message: text.slice(0, m.index) + f.message + text.slice(m.index + m[0].length) }
  }
  return { message: text }
}
