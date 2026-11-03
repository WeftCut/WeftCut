import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCheck, LocateFixed, Undo2 } from 'lucide-react'
import { useProjectStore } from '../state/projectStore'
import { AppIcon } from '@/components/AppIcon'
import { approveAllChanges, revertAllChanges, setShowUser, useChangeWords, useReview, useReviewView } from './reviewStore'
import { groupChanges, sessionReason, sessionReasonIndex, type ChangeRow } from './changeModel'
import { changePlace, changeTitle, describeChange } from './changeWords'
import { canLocate, locate } from './locate'
import { JumpButton } from './JumpButton'
import { useAgentActivity } from './activityStore'
import { setReviewFocus, setReviewHover, useReviewFocus } from './reviewFocus'

/** The Changes tab of the shared agent panel (ADR 0115): what differs from the
 *  Review baseline because an agent touched it, grouped by composition and in
 *  timeline order; locate is the editor's alone
 *  (docs/mcp.md#agent-panel-and-lifecycle).
 *
 *  The list is settled as a whole, never row by row: Approve all makes the
 *  current state the baseline, Revert all restores the baseline as one
 *  undoable commit (as a checkpoint restore does, so not under the history
 *  lock). Both compare whole states, so both take the user's own differences
 *  with the agent's.
 *
 *  "Show my changes" lists the differences only the user made, too. They need
 *  no approval — the baseline is what the user accepted, and their own edits
 *  are accepted by making them — so their rows are muted and marked as the
 *  user's. Main sends them only while shown.
 *
 *  Either action names the list on screen; one made after an agent changed
 *  the list does nothing and says so in the toolbar, over the fresh list.
 *
 *  A row's click focuses its change (the review focus, shared with the
 *  timelines: its range washed, its clips or ghost outlined, the others'
 *  marks stepping back); a second click lets it go. Hovering a row outlines
 *  its clips. Neither seeks — Locate does.
 *
 *  Each row describes one entity and identifies its work session.
 */
export function ChangesTab({ editor }: { editor: boolean }) {
  const { t } = useTranslation()
  const view = useReviewView()
  const showUser = useReview(s => s.showUser)
  const stale = useReview(s => s.actionStale)
  const summary = useProjectStore(s => s.summary)
  const [busy, setBusy] = useState(false)
  const focus = useReviewFocus(s => s.focus)
  const selected = focus?.kind === 'change' && focus.source === 'review' ? focus.id : null
  const list = useRef<HTMLDivElement>(null)
  const activity = useAgentActivity(s => s.snapshot)
  const reasons = useMemo(() => sessionReasonIndex(activity), [activity])
  const words = useChangeWords({ frame: 'review' })
  const unreviewed = view?.unreviewed ?? []
  const groups = useMemo(
    () => (view ? groupChanges(view.unreviewed, showUser ? view.user : [], summary?.root_id ?? null) : []),
    [view, showUser, summary?.root_id])

  // A ghost or a mini timeline band focuses a change; bring its row into view.
  useEffect(() => {
    if (focus?.kind !== 'change' || focus.source !== 'review') return
    const row = list.current?.querySelector<HTMLElement>(`[data-change-id="${CSS.escape(focus.id)}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [focus])
  // A row unmounted under the pointer never hears it leave.
  useEffect(() => () => {
    if (useReviewFocus.getState().hover?.kind === 'change') setReviewHover(null)
  }, [])

  const locked = activity?.lock_reason != null
  const settle = async (run: () => Promise<boolean>) => {
    if (busy) return
    setBusy(true)
    try { await run() } finally { setBusy(false) }
  }

  /** A group heading: the composition's name, whole-composition changes
   *  under "Groups", a composition gone since as a removed group. */
  const heading = (id: string | null): string =>
    id === null ? t('changes.group_project') : words.compositionName(id) ?? t('changes.group_gone')

  const row = (r: ChangeRow) => {
    const { change: c, source } = r
    const when = changePlace(c, words)
    const reason = source === 'agent' ? sessionReason(c, reasons) : null
    const locatable = editor && canLocate({ kind: 'change', change: c })
    const focused = selected === c.id
    return <article key={`${source}-${c.id}`} data-change-id={c.id} data-source={source} data-selected={focused ? 'true' : undefined}
      className={`agent-change class-${c.class} source-${source}`}
      onMouseEnter={() => setReviewHover({ kind: 'change', source: 'review', id: c.id })} onMouseLeave={() => setReviewHover(null)}>
      <div className="agent-tack-row">
        <button type="button" className="agent-tack-main agent-change-main" aria-pressed={focused}
          onClick={() => setReviewFocus(focused ? null : { kind: 'change', source: 'review', id: c.id })}>
          <span className={`agent-change-badge class-${c.class}`}>{t(`changes.class_${c.class}`)}</span>
          <span className="agent-activity-copy agent-change-copy"><span>{changeTitle(c, words)}</span>
            <small title={when?.timecode}>{[describeChange(c, words), when?.text].filter(Boolean).join(' · ')}</small>
            {reason && <small className="agent-change-from">{t('changes.from_session', { reason })}</small>}</span>
        </button>
        {source === 'user' && <span className="agent-change-mine" title={t('changes.mine_hint')}>{t('changes.mine')}</span>}
        {editor ? <button type="button" aria-label={t('changes.locate')} title={t('changes.locate')} disabled={!locatable}
          onClick={() => locate({ kind: 'change', change: c })}><AppIcon icon={LocateFixed} size="body" /></button>
          : <JumpButton item={{ kind: 'change', change: c }} onJump={() => setReviewFocus({ kind: 'change', source: 'review', id: c.id })} />}
      </div>
    </article>
  }

  const userCount = view?.user_count ?? 0
  const empty = !view ? 'agent_panel.loading' : !view.has_baseline ? 'changes.no_baseline' : 'changes.empty'
  const canShowUser = userCount > 0
  const toolbar = canShowUser || stale || unreviewed.length > 0
  return <div className="agent-tacks agent-changes" role="tabpanel" aria-label={t('agent_panel.tab_changes')}>
    {/* The unreviewed count is the tab's badge; the subtitle, its title. The
        toolbar holds only what can act: Approve all and Revert all while
        something awaits review, the user's filter while they have changes. */}
    {toolbar && <div className="agent-activity-toolbar">
      {canShowUser && <button type="button" aria-pressed={showUser} title={t('changes.show_mine_hint')}
        onClick={() => setShowUser(!showUser)}>{t('changes.show_mine', { count: userCount })}</button>}
      {stale && <span className="agent-changes-stale" role="status" title={t(`changes.${stale}_stale`)}>{t(`changes.${stale}_stale_short`)}</span>}
      {unreviewed.length > 0 && <>
        <button type="button" className="agent-changes-revert-all" disabled={busy || locked}
          title={locked ? t('changes.revert_all_locked') : t('changes.revert_all_hint')}
          onClick={() => void settle(revertAllChanges)}><AppIcon icon={Undo2} size="body" />{t('changes.revert_all')}</button>
        <button type="button" className="agent-changes-approve-all" disabled={busy} title={t('changes.approve_all_hint')}
          onClick={() => void settle(approveAllChanges)}><AppIcon icon={CheckCheck} size="body" />{t('changes.approve_all')}</button>
      </>}
    </div>}
    <div className="agent-activity-list" ref={list}>
      {!groups.length && (view
        ? <div className="agent-empty"><p>{t(empty)}</p><p className="agent-empty-subtitle">{t('changes.retention')}</p></div>
        : <p className="agent-empty">{t(empty)}</p>)}
      {groups.map(g => <section key={g.compositionId ?? 'project'} className="agent-work-group agent-change-group">
        <h3 className="agent-change-group-heading"><span>{heading(g.compositionId)}</span>
          <small>{t('changes.group_count', { count: g.rows.filter(r => r.source === 'agent').length })}</small></h3>
        {g.rows.map(row)}
      </section>)}
      {groups.length > 0 && <p className="agent-retention-note agent-list-footnote">{t('changes.retention')}</p>}
    </div>
  </div>
}
