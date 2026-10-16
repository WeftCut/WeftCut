import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CheckCheck, LocateFixed } from 'lucide-react'
import { useProjectStore } from '../state/projectStore'
import { AppIcon } from '@/components/AppIcon'
import { approveAllChanges, approveChanges, setShowUser, useChangeWords, useReview, useReviewView } from './reviewStore'
import { groupChanges, sessionReason, sessionReasonIndex, type ChangeRow } from './changeModel'
import { changePlace, changeTitle, describeChange } from './changeWords'
import { canLocate, locate } from './locate'
import { JumpButton } from './JumpButton'
import { useAgentActivity } from './activityStore'
import { setReviewFocus, setReviewHover, useReviewFocus } from './reviewFocus'

/** The Changes tab of the shared agent panel (ADR 0115): what differs from the
 *  Review baseline because an agent touched it, grouped by composition and in
 *  timeline order. Approve one or all; locate is the editor's alone (ADR 0065).
 *
 *  "Show my changes" lists the differences only the user made, too. They need
 *  no approval — the baseline is what the user accepted, and their own edits
 *  are accepted by making them — so their rows are muted, marked as the
 *  user's, and carry no approve button. Main sends them only while shown.
 *
 *  An approval names the list on screen; one made after an agent changed the
 *  list approves nothing and says so beside Approve all, over the fresh list.
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
  const stale = useReview(s => s.approvalStale)
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

  const approve = async (run: () => Promise<boolean>) => {
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
        {source === 'agent' && <button type="button" aria-label={t('changes.approve')} title={t('changes.approve_hint')} disabled={busy}
          onClick={() => void approve(() => approveChanges([c.id]))}><AppIcon icon={Check} size="body" /></button>}
      </div>
    </article>
  }

  const userCount = view?.user_count ?? 0
  const empty = !view ? 'agent_panel.loading' : !view.has_baseline ? 'changes.no_baseline' : 'changes.empty'
  return <div className="agent-tacks agent-changes" role="tabpanel" aria-label={t('agent_panel.tab_changes')}>
    {/* The unreviewed count is the tab's badge; the subtitle, its title (and
        the emptied list's: "no baseline yet" already says what lands here). */}
    <div className="agent-activity-toolbar">
      <button type="button" aria-pressed={showUser} title={t('changes.show_mine_hint')}
        onClick={() => setShowUser(!showUser)}>{t('changes.show_mine', { count: userCount })}</button>
      {stale && <span className="agent-changes-stale" role="status" title={t('changes.approval_stale')}>{t('changes.approval_stale_short')}</span>}
      <button type="button" className="agent-changes-approve-all" disabled={busy || unreviewed.length === 0} title={t('changes.approve_all_hint')}
        onClick={() => void approve(approveAllChanges)}><AppIcon icon={CheckCheck} size="body" />{t('changes.approve_all')}</button>
    </div>
    <div className="agent-activity-list" ref={list}>
      {!groups.length && (view?.has_baseline
        ? <div className="agent-empty"><p>{t(empty)}</p><p className="agent-empty-subtitle">{t('changes.subtitle')}</p></div>
        : <p className="agent-empty">{t(empty)}</p>)}
      {groups.map(g => <section key={g.compositionId ?? 'project'} className="agent-work-group agent-change-group">
        <h3 className="agent-change-group-heading"><span>{heading(g.compositionId)}</span>
          <small>{t('changes.group_count', { count: g.rows.filter(r => r.source === 'agent').length })}</small></h3>
        {g.rows.map(row)}
      </section>)}
      <p className="agent-retention-note agent-list-footnote">{t('changes.retention')}</p>
    </div>
  </div>
}
