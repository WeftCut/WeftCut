// apps/desktop/src/main/lint/audits.ts
//
// The host's memory of the last audit per composition (spec H1-D6): what lets
// `end_agent_session` and `start_export` say whether the composition has been
// checked since its last change, rather than trusting the agent's account.
// Runtime state for one project opening, like tacks — never saved, and
// cleared when another project opens.

import type { Project } from '../state/model'
import type { TasteView } from '../taste/view'
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

  /** Forget everything when the project changes underneath. */
  private scope(p: Project) {
    if (p.project_id !== this.projectId) { this.last.clear(); this.projectId = p.project_id }
  }

  /** Check the whole composition, remember it, and answer the findings in
   *  `range` (all of them without one). */
  run(p: Project, compositionId: string, taste: TasteView | null, range?: [number, number]): CheckResult {
    this.scope(p)
    const full = checkComposition(p, compositionId, taste)
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
    const state: AuditState = compositionRevision(comp, taste) === last.revision ? 'fresh' : 'stale'
    return { composition_id: compositionId, state, ...last.counts }
  }
}
