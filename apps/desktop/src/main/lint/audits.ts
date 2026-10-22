// apps/desktop/src/main/lint/audits.ts
//
// The host's memory of the last audit per composition (spec H1-D6): what lets
// `end_agent_session` and `start_export` say whether the composition has been
// checked since its last change, rather than trusting the agent's account.
// Runtime state for one project opening, like tacks — never saved, and
// cleared when another project opens.

import type { Project } from '../state/model'
import type { MotifLookup, TasteView } from '../taste/view'
import { checkComposition, compositionRevision, type CheckResult, type Finding } from './checkComposition'

export type AuditState = 'fresh' | 'stale' | 'never'

export interface AuditSummary {
  composition_id: string
  state: AuditState
  /** Counts at the last audit; absent when there was none. */
  hard?: number
  warning?: number
  review?: number
}

export class AuditStore {
  private last = new Map<string, CheckResult>()
  private projectId: string | null = null

  /** `motif` gives the audit Motif manifests (built-in, installed and drafts
   *  alike): where a Motif layer sits and what text it shows. */
  constructor(private readonly motif?: MotifLookup) {}

  /** Forget everything when the project changes underneath. */
  private scope(p: Project) {
    if (p.project_id !== this.projectId) { this.last.clear(); this.projectId = p.project_id }
  }

  /** Check the whole composition, remember it, and answer the findings in
   *  `range` (all of them without one). */
  run(p: Project, compositionId: string, taste: TasteView | null, range?: [number, number]): CheckResult {
    this.scope(p)
    const full = checkComposition(p, compositionId, taste, undefined, { motif: this.motif })
    this.last.set(compositionId, full)
    if (!range) return full
    const findings = full.findings.filter((f: Finding) => f.range[0] < range[1] && f.range[1] > range[0])
    const counts = { hard: 0, warning: 0, review: 0 }
    for (const f of findings) counts[f.severity]++
    return { ...full, findings, counts }
  }

  summary(p: Project, compositionId: string, taste: TasteView | null): AuditSummary {
    this.scope(p)
    const comp = p.compositions[compositionId]
    const last = this.last.get(compositionId)
    if (!comp || !last) return { composition_id: compositionId, state: 'never' }
    const state: AuditState = compositionRevision(p, compositionId, taste) === last.revision ? 'fresh' : 'stale'
    return { composition_id: compositionId, state, ...last.counts }
  }
}

/** `end_agent_session`'s answer when it keeps the session open for the audit
 *  it just ran: the hard and warning findings (the first `shown`), and what
 *  ends the session. */
export function heldForAudit(check: CheckResult, shown = 20): Record<string, unknown> {
  const findings = check.findings.filter((f) => f.severity !== 'review')
  return {
    ended: null,
    held: 'audit',
    audit: {
      composition_id: check.composition_id, state: 'fresh' as AuditState, ...check.counts,
      findings: findings.slice(0, shown), ...(findings.length > shown ? { more: findings.length - shown } : {}),
    },
    next: `The session is still open: the audit of your final state found ${check.counts.hard} hard and ${check.counts.warning} warning finding(s). Fix every hard one, fix each warning or leave a tack saying why not, then call end_agent_session again. With no edit in between, that call ends the session.`,
  }
}
