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
//   native sentence after the tag): a busy budget (`ResourceBusy`, naming what
//   holds it) or a claim no wait can admit (`ResourceBudget`, naming the
//   setting), never a crash.
//
// `describeFault` rewrites all three into a sentence and names the variant, so
// `toolErrorResult` (every refusal) and the export records (a failed job's
// `error.message`) answer in one vocabulary. Text that is none of these comes
// back unchanged.
import { RESOURCE_CAPACITY_EXCEEDED, WORK_FRACTION, memoryTargetForWork, type ResourceHolder } from '../../shared/resource-policy'
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

/** Where the setting that sizes the working allowance lives. */
export const MEMORY_SETTING = 'Settings › Performance › Memory target'
/** When a busy budget may have room again; null where waiting does not help. */
const RETRY_AFTER_S: Record<string, number | null> = { busy: 15, pressure: 5, 'host-pressure': 30, 'budget-too-small': null }

const REASON_TEXT: Record<string, string> = {
  busy: 'other work holds the rest of the budget — retry when it finishes',
  pressure: 'the app is under memory pressure — retry in a few seconds',
  'host-pressure': 'the computer is low on free memory — close other programs or retry later',
}

/** The live ledger's holders, for a refusal whose text carries none (the
 *  native sentences). Installed by main; absent in tests and before boot. */
let liveHolders: () => ResourceHolder[] = () => []
export function setResourceHolders(read: () => ResourceHolder[]): void { liveHolders = read }
function currentHolders(): ResourceHolder[] {
  try { return liveHolders() } catch { return [] }
}

/** `proxy of media 1f… (512 MiB), export (2048 MiB)`. */
export function holdersPhrase(holders: ResourceHolder[]): string {
  const named = holders.slice(0, 4).map((h) => `${h.kind.replace(/_/g, ' ')}${h.media_id ? ` of media ${h.media_id}` : ''} (${h.mib} MiB)`)
  return holders.length > 4 ? `${named.join(', ')} and ${holders.length - 4} more` : named.join(', ')
}

/** A claim larger than the whole working allowance. No wait admits it; only
 *  a larger memory target does, and that is the user's setting. */
function budgetFault(needed: number, allowed: number): Fault {
  const target = memoryTargetForWork(needed)
  return {
    error: 'ResourceBudget', code: 'invalid_request',
    data: { needed_mib: needed, allowed_mib: allowed, setting: MEMORY_SETTING, memory_target_mib: target, retry_after_s: null },
    message: `this needs ${needed} MiB of working memory and the allowance is ${allowed} MiB (${Math.round(WORK_FRACTION * 100)} % of the memory target), so it cannot run at the current settings and waiting will not help — ask the user to raise ${MEMORY_SETTING} to at least ${target} MiB`,
  }
}

const BUDGET_SENTENCE = /Requested (\d+) MiB working memory exceeds the (\d+) MiB allowance/

function resourceFault(after: string): Fault {
  const body = after.trim()
  if (body.startsWith('{')) {
    try {
      const b = JSON.parse(body) as { reason?: string; requestedMiB?: number; availableMiB?: number; workMiB?: number; holders?: ResourceHolder[] }
      const reason = typeof b.reason === 'string' ? b.reason : 'busy'
      if (reason === 'budget-too-small' && typeof b.requestedMiB === 'number' && typeof b.workMiB === 'number') return budgetFault(b.requestedMiB, b.workMiB)
      const holders = Array.isArray(b.holders) ? b.holders : []
      const why = reason === 'busy' && holders.length ? `held by ${holdersPhrase(holders)} — retry when that finishes` : REASON_TEXT[reason] ?? REASON_TEXT.busy
      return {
        error: 'ResourceBusy', code: 'invalid_request',
        data: { reason, requested_mib: b.requestedMiB ?? null, available_mib: b.availableMiB ?? null, budget_mib: b.workMiB ?? null, holders, retry_after_s: RETRY_AFTER_S[reason] ?? RETRY_AFTER_S.busy },
        message: `not enough processing memory right now: this needs about ${b.requestedMiB ?? '?'} MiB and ${b.availableMiB ?? '?'} MiB of the ${b.workMiB ?? '?'} MiB budget is free; ${why}`,
      }
    } catch { /* not the JSON block: the native sentence path below */ }
  }
  const budget = BUDGET_SENTENCE.exec(body)
  if (budget) return budgetFault(Number(budget[1]), Number(budget[2]))
  // The native sentence names the holders in words already; the data names
  // them from the live ledger.
  const reason = /memory is under pressure/.test(body) ? 'pressure' : 'busy'
  return { error: 'ResourceBusy', code: 'invalid_request', data: { reason, holders: currentHolders(), retry_after_s: RETRY_AFTER_S[reason] },
    message: `not enough processing resources right now: ${body || 'the budget is held'}` }
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
