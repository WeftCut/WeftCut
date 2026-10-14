import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CheckCheck, LocateFixed } from 'lucide-react'
import type { Change } from '../../shared/review'
import { formatTimecode } from '../frames'
import { groupDisplayName, layerDisplayName } from '../lib/layerName'
import { trackDisplayName } from '../lib/trackName'
import { useProjectStore } from '../state/projectStore'
import { AppIcon } from '@/components/AppIcon'
import { approveAllChanges, approveChanges, setShowUser, useReview, useReviewView } from './reviewStore'
import { carriedAlong, groupChanges, keyIds, sessionReason, sessionReasonIndex, type ChangeRow } from './changeModel'
import { changeWordsContext, describeCarried, describeChange } from './changeWords'
import { canLocateChange, locateChange } from './changeActions'
import { useAgentActivity } from './activityStore'

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
 *  list approves nothing and says so above the fresh list.
 *
 *  A row's click focuses its change (the review focus, shared with the
 *  timelines: its range washed, its clips or ghost outlined, the others'
 *  marks stepping back); a second click lets it go. Hovering a row outlines
 *  its clips. Neither seeks — Locate does.
 *
 *  A row says what changed in relative words (`changeWords.ts`); the content
 *  its edit carried along folds under it as quiet sub-lines, one per amount —
 *  counting the clips it carried that were edited too, which keep rows of
 *  their own — and an agent row names the work session that made it
 *  ("From: …"). */
export function ChangesTab({ editor }: { editor: boolean }) {
  const { t } = useTranslation()
  const view = useReviewView()
  const showUser = useReview(s => s.showUser)
  const stale = useReview(s => s.approvalStale)
  const summary = useProjectStore(s => s.summary)
  const layers = useProjectStore(s => s.layerById)
  const ordinals = useProjectStore(s => s.groupOrdinals)
  const [busy, setBusy] = useState(false)
  const focus = useAgentActivity(s => s.reviewFocus)
  const selected = focus?.kind === 'change' ? focus.id : null
  const setHover = useAgentActivity(s => s.setReviewHover)
  const list = useRef<HTMLDivElement>(null)
  const activity = useAgentActivity(s => s.snapshot)
  const reasons = useMemo(() => sessionReasonIndex(activity), [activity])
  const words = useMemo(() => changeWordsContext(t, summary, ordinals), [t, summary, ordinals])
  const unreviewed = view?.unreviewed ?? []
  const groups = useMemo(
    () => (view ? groupChanges(view.unreviewed, showUser ? view.user : [], summary?.root_id ?? null) : []),
    [view, showUser, summary?.root_id])

  // A ghost or a mini timeline band focuses a change; bring its row into view.
  useEffect(() => {
    if (focus?.kind !== 'change') return
    const row = list.current?.querySelector<HTMLElement>(`[data-change-id="${CSS.escape(focus.id)}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [focus])
  // A row unmounted under the pointer never hears it leave.
  useEffect(() => () => {
    if (useAgentActivity.getState().reviewHover?.kind === 'change') useAgentActivity.getState().setReviewHover(null)
  }, [])

  const approve = async (run: () => Promise<boolean>) => {
    if (busy) return
    setBusy(true)
    try { await run() } finally { setBusy(false) }
  }

  const compositionName = (id: string | null): string => {
    if (id === null) return t('changes.group_project')
    if (id === summary?.root_id) return t('changes.group_root')
    const c = summary?.compositions[id]
    return c ? groupDisplayName(id, c.label, ordinals, t) : t('changes.group_gone')
  }

  /** What the row names: the clip, marker, track or Group as the rest of the
   *  app names it when it still exists; its kind when it is gone. */
  const title = (c: Change): string => {
    if (c.delta_us !== undefined) {
      const clips = keyIds(c, 'Layer').length, marks = keyIds(c, 'Marker').length
      return [clips && t('changes.n_clips', { count: clips }), marks && t('changes.n_markers', { count: marks })].filter(Boolean).join(', ')
    }
    const id = keyIds(c, c.kind)[0]
    const fallback = t(`changes.kind_${c.kind}`)
    if (id === undefined || !summary) return fallback
    switch (c.kind) {
      case 'Layer': { const l = layers.get(id); return l ? layerDisplayName(l, t, ordinals) : fallback }
      case 'Marker': {
        const m = c.composition_id ? summary.compositions[c.composition_id]?.markers.find(x => x.id === id) : undefined
        return m?.label.trim() || fallback
      }
      case 'Track': {
        const comp = c.composition_id ? summary.compositions[c.composition_id] : undefined
        const track = comp?.tracks.find(x => x.id === id)
        return track && comp ? trackDisplayName(track, comp.tracks, t) : fallback
      }
      case 'Composition': {
        const comp = summary.compositions[id]
        return comp ? groupDisplayName(id, comp.label, ordinals, t) : fallback
      }
      default: return fallback
    }
  }

  const time = (c: Change): string | null => {
    const r = c.ranges.find(x => x.composition_id === c.composition_id) ?? c.ranges[0]
    const comp = r ? summary?.compositions[r.composition_id] : undefined
    if (!r || !comp) return null
    const start = formatTimecode(r.t_start_us, comp.fps_num, comp.fps_den)
    return r.t_end_us > r.t_start_us ? `${start} – ${formatTimecode(r.t_end_us, comp.fps_num, comp.fps_den)}` : start
  }

  const row = (r: ChangeRow) => {
    const { change: c, source } = r
    const when = time(c)
    const reason = source === 'agent' ? sessionReason(c, reasons) : null
    const locatable = editor && canLocateChange(c)
    const focused = selected === c.id
    return <article key={`${source}-${c.id}`} data-change-id={c.id} data-source={source} data-selected={focused ? 'true' : undefined}
      className={`agent-change class-${c.class} source-${source}`}
      onMouseEnter={() => setHover({ kind: 'change', id: c.id })} onMouseLeave={() => setHover(null)}>
      <div className="agent-tack-row">
        <button type="button" className="agent-tack-main agent-change-main" aria-pressed={focused}
          onClick={() => useAgentActivity.getState().setReviewFocus(focused ? null : { kind: 'change', id: c.id })}>
          <span className={`agent-change-badge class-${c.class}`}>{t(`changes.class_${c.class}`)}</span>
          <span className="agent-activity-copy agent-change-copy"><span>{title(c)}</span>
            <small>{[describeChange(c, words), when].filter(Boolean).join(' · ')}</small>
            {carriedAlong(r).map(k => <small key={k.delta_us} className="agent-change-carried">{describeCarried(k, t)}</small>)}
            {reason && <small className="agent-change-from">{t('changes.from_session', { reason })}</small>}</span>
        </button>
        {source === 'user' && <span className="agent-change-mine" title={t('changes.mine_hint')}>{t('changes.mine')}</span>}
        {editor && <button type="button" aria-label={t('changes.locate')} title={t('changes.locate')} disabled={!locatable}
          onClick={() => locateChange(c)}><AppIcon icon={LocateFixed} size="body" /></button>}
        {source === 'agent' && <button type="button" aria-label={t('changes.approve')} title={t('changes.approve_hint')} disabled={busy}
          onClick={() => void approve(() => approveChanges([c.id]))}><AppIcon icon={Check} size="body" /></button>}
      </div>
    </article>
  }

  const userCount = view?.user_count ?? 0
  const empty = !view ? 'agent_panel.loading' : !view.has_baseline ? 'changes.no_baseline' : 'changes.empty'
  return <div className="agent-tacks agent-changes" role="tabpanel" aria-label={t('agent_panel.tab_changes')}>
    <p className="agent-tacks-subtitle">{t('changes.subtitle')}</p>
    <div className="agent-activity-toolbar">
      <span className="agent-tacks-count">{t('changes.unreviewed_count', { count: unreviewed.filter(c => !c.carried).length })}</span>
      <button type="button" aria-pressed={showUser} title={t('changes.show_mine_hint')}
        onClick={() => setShowUser(!showUser)}>{t('changes.show_mine', { count: userCount })}</button>
      <button type="button" className="agent-changes-approve-all" disabled={busy || unreviewed.length === 0} title={t('changes.approve_all_hint')}
        onClick={() => void approve(approveAllChanges)}><AppIcon icon={CheckCheck} size="body" />{t('changes.approve_all')}</button>
    </div>
    {stale && <p className="agent-tacks-subtitle" role="status">{t('changes.approval_stale')}</p>}
    <div className="agent-activity-list" ref={list}>
      {!groups.length && <p className="agent-empty">{t(empty)}</p>}
      {groups.map(g => <section key={g.compositionId ?? 'project'} className="agent-work-group agent-change-group">
        <h3 className="agent-change-group-heading"><span>{compositionName(g.compositionId)}</span>
          <small>{t('changes.group_count', { count: g.rows.filter(r => r.source === 'agent' && !r.change.carried).length })}</small></h3>
        {g.rows.map(row)}
      </section>)}
    </div>
    <footer className="agent-retention-note" title={t('changes.retention')}>{t('changes.retention')}</footer>
  </div>
}
