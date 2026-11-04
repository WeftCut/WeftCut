// Admission refusals in the error model's words: a busy budget names what
// holds it and when to retry (sim L3/L8/L12: agents ran pgrep and listed
// Cache/proxies to find out), and a claim larger than the whole allowance is
// the typed `ResourceBudget` naming the setting (sim R2, NEW-12).
import { afterEach, describe, expect, it } from 'vitest'
import { describeFault, setResourceHolders } from './faultText'
import { resourceBlockError } from '../../shared/export-resources'

afterEach(() => setResourceHolders(() => []))

describe('describeFault: resource admission', () => {
  it('a blocked export plan names its holders and a retry hint', () => {
    const raw = `Error invoking remote method 'resources:plan-export': Error: ${resourceBlockError({
      kind: 'blocked', reason: 'busy', requestedMiB: 700, availableMiB: 120, workMiB: 4505, revision: 3,
      holders: [{ kind: 'proxy', media_id: 'm-1', mib: 3200, threads: 2 }, { kind: 'editor', mib: 96, threads: 0 }],
    }).message}`
    const f = describeFault(raw)
    expect(f.error).toBe('ResourceBusy')
    expect(f.message).toContain('held by proxy of media m-1 (3200 MiB), editor (96 MiB)')
    expect(f.message).not.toMatch(/Error invoking|resource-capacity-exceeded|\{/)
    expect(f.data).toMatchObject({ reason: 'busy', holders: [{ kind: 'proxy', media_id: 'm-1' }, { kind: 'editor' }], retry_after_s: 15 })
  })

  it('a native busy sentence keeps its words and takes the holders from the live ledger', () => {
    setResourceHolders(() => [{ kind: 'export', mib: 2048, threads: 2 }])
    const f = describeFault('resource-capacity-exceeded: Resources are busy, held by export (2048 MiB). Retry when that finishes, or stop playback')
    expect(f.error).toBe('ResourceBusy')
    expect(f.message).toContain('held by export (2048 MiB)')
    expect(f.data).toMatchObject({ reason: 'busy', holders: [{ kind: 'export', mib: 2048 }], retry_after_s: 15 })
  })

  it('a model larger than the whole allowance is ResourceBudget, naming the setting', () => {
    const f = describeFault('resource-capacity-exceeded: Requested 6615 MiB working memory exceeds the 4505 MiB allowance; raise the Memory target in Settings › Performance')
    expect(f.error).toBe('ResourceBudget')
    expect(f.code).toBe('invalid_request')
    expect(f.data).toEqual({ needed_mib: 6615, allowed_mib: 4505, setting: 'Settings › Performance › Memory target', memory_target_mib: 16640, retry_after_s: null })
    expect(f.message).toContain('at least 16640 MiB')
    expect(f.message).not.toMatch(/io error|resource-capacity-exceeded/)
  })

  it('an export plan larger than the budget is the same ResourceBudget', () => {
    const f = describeFault(resourceBlockError({ kind: 'blocked', reason: 'budget-too-small', requestedMiB: 1200, availableMiB: 921, workMiB: 921, revision: 1 }).message)
    expect(f.error).toBe('ResourceBudget')
    expect(f.data).toMatchObject({ needed_mib: 1200, allowed_mib: 921, memory_target_mib: 3072 })
  })
})
