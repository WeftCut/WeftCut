import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, CircleHelp, LocateFixed, StickyNote, TriangleAlert, X } from 'lucide-react'
import type { TackKind, TackView } from '../../shared/agent-activity'
import { formatTimecode } from '../frames'
import { groupDisplayName, groupOrdinals } from '../lib/layerName'
import { useProjectStore } from '../state/projectStore'
import { AppIcon } from '@/components/AppIcon'
import { tackGroupKey, tackRowKey, useAgentActivity } from './activityStore'
import { setReviewFocus, setReviewHover, useReviewFocus } from './reviewFocus'
import { groupTacks, tackUnplacedReason } from './tackModel'
import { convertTackToMarker, deleteTacks, locateTack, setTackStatus } from './tackActions'

const KIND_ICON: Record<TackKind, typeof StickyNote> = { note: StickyNote, issue: TriangleAlert, question: CircleHelp }
const NO_TACKS: TackView[] = []

/** The Tacks tab of the shared agent panel: what agents tacked on for review,
 *  grouped by the work session that left them. Locate is the editor's alone
 *  (ADR 0065); everything else is the same in both layouts.
 *
 *  A row's click focuses its tack (the review focus, shared with the
 *  timelines: its chip, its range, the clip it follows), and hovering it
 *  outlines its chip. A tack whose composition is gone sorts to the foot of
 *  its group; it can only be closed or cleared. */
export function TacksTab({ editor }: { editor: boolean }) {
  const { t } = useTranslation()
  const tacks = useAgentActivity(s => s.snapshot?.tacks ?? NO_TACKS)
  const sessions = useAgentActivity(s => s.snapshot?.sessions)
  const ready = useAgentActivity(s => s.ready)
  const expanded = useAgentActivity(s => s.expanded)
  const toggle = useAgentActivity(s => s.toggle)
  const focus = useReviewFocus(s => s.focus)
  const selected = focus?.kind === 'tack' ? focus.id : null
  const summary = useProjectStore(s => s.summary)
  const list = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => groupTacks(tacks, sessions ?? [], tackGroupKey), [tacks, sessions])
  const ordinals = useMemo(() => summary ? groupOrdinals(summary.compositions, summary.root_id) : undefined, [summary])
  const closed = tacks.filter(x => x.status !== 'open').length

  // A chip, a mini timeline band or a locate focuses a tack; bring its row
  // into view. Per focus object, so selecting the same tack again finds a row
  // the list has since scrolled away from.
  useEffect(() => {
    if (focus?.kind !== 'tack') return
    const row = list.current?.querySelector<HTMLElement>(`[data-tack-id="${CSS.escape(focus.id)}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [focus])
  // A row unmounted under the pointer never hears it leave.
  useEffect(() => () => {
    if (useReviewFocus.getState().hover?.kind === 'tack') setReviewHover(null)
  }, [])

  const placeAt = (compositionId: string, tUs: number, endTUs: number | null): string | null => {
    const c = summary?.compositions[compositionId]
    if (!c) return null
    const time = formatTimecode(tUs, c.fps_num, c.fps_den) + (endTUs === null ? '' : ` – ${formatTimecode(endTUs, c.fps_num, c.fps_den)}`)
    return c.id === summary?.root_id ? time : `${groupDisplayName(c.id, c.label, ordinals, t)} · ${time}`
  }

  const place = (x: TackView): string => {
    if (x.composition_id === null || x.t_us === null) return t('tacks.state_unplaced')
    return placeAt(x.composition_id, x.t_us, x.end_t_us) ?? '—'
  }

  const row = (x: TackView) => {
    const open = expanded[tackRowKey(x.id)] ?? false
    const reason = tackUnplacedReason(x)
    const why = reason ? t(reason) : null
    const statusToggle = (status: 'resolved' | 'dismissed') => void setTackStatus([x.id], x.status === status ? 'open' : status)
    const focusThis = () => setReviewFocus({ kind: 'tack', id: x.id })
    return <article key={x.id} data-tack-id={x.id} data-selected={selected === x.id ? 'true' : undefined}
      className={`agent-tack status-${x.status}${reason ? ' unplaced' : ''}`}
      onMouseEnter={() => setReviewHover({ kind: 'tack', id: x.id })} onMouseLeave={() => setReviewHover(null)}>
      <div className="agent-tack-row">
        <button type="button" className="agent-tack-main" aria-expanded={open}
          onClick={() => { toggle(tackRowKey(x.id)); focusThis() }}>
          <AppIcon icon={KIND_ICON[x.kind]} size="title" className={`agent-tack-kind kind-${x.kind}`} aria-label={t(`tacks.kind_${x.kind}`)} />
          <span className="agent-activity-copy"><span>{x.label}</span><small title={why ?? undefined}>{place(x)}</small></span>
          {x.outdated && x.status === 'open' && <span className="agent-tack-outdated" title={t('tacks.outdated_hint')}>{t('tacks.outdated')}</span>}
          <span className="agent-tack-status">{t(`tacks.status_${x.status}`)}</span>
          {open ? <AppIcon icon={ChevronDown} size="body" /> : <AppIcon icon={ChevronRight} size="body" />}
        </button>
        {editor && <button type="button" aria-label={t('tacks.locate')} title={why ?? t('tacks.locate')} disabled={reason !== null}
          onClick={() => { focusThis(); locateTack(x) }}><AppIcon icon={LocateFixed} size="body" /></button>}
        <button type="button" aria-pressed={x.status === 'resolved'} aria-label={t(x.status === 'resolved' ? 'tacks.reopen' : 'tacks.resolve')}
          title={t(x.status === 'resolved' ? 'tacks.reopen' : 'tacks.resolve')} onClick={() => statusToggle('resolved')}><AppIcon icon={Check} size="body" /></button>
        <button type="button" aria-pressed={x.status === 'dismissed'} aria-label={t(x.status === 'dismissed' ? 'tacks.reopen' : 'tacks.dismiss')}
          title={t(x.status === 'dismissed' ? 'tacks.reopen' : 'tacks.dismiss')} onClick={() => statusToggle('dismissed')}><AppIcon icon={X} size="body" /></button>
      </div>
      {open && <div className="agent-activity-details">
        <p className="agent-tack-body">{x.body.trim() || t('tacks.no_body')}</p>
        <dl><dt>{t('tacks.kind')}</dt><dd>{t(`tacks.kind_${x.kind}`)}</dd>
          <dt>{t('agent_panel.client')}</dt><dd>{x.client}</dd>
          {why && <><dt>{t('tacks.place')}</dt><dd>{why}</dd></>}</dl>
        <button type="button" disabled={reason !== null} title={why ?? t('tacks.convert_hint')} onClick={() => void convertTackToMarker(x)}>{t('tacks.convert')}</button>
      </div>}
    </article>
  }

  return <div className="agent-tacks" role="tabpanel" aria-label={t('agent_panel.tab_tacks')}>
    {/* The open count is the tab's badge; the subtitle, its title — the
        empty list's message already says what lands here. The toolbar's one
        action shows only while there is something to clear. */}
    {closed > 0 && <div className="agent-activity-toolbar">
      <button type="button" title={t('tacks.clear_closed_hint')}
        onClick={() => void deleteTacks({ statuses: ['resolved', 'dismissed'] })}>{t('tacks.clear_closed', { count: closed })}</button>
    </div>}
    <div className="agent-activity-list" ref={list}>
      {!groups.length && <p className="agent-empty">{t(ready ? 'tacks.empty' : 'agent_panel.loading')}</p>}
      {groups.map(g => {
        const defaultOpen = g.tacks.some(x => x.status === 'open')
        const open = expanded[g.key] ?? defaultOpen
        const title = g.session?.reason ?? t(g.sessionId === null ? 'tacks.outside_session' : 'tacks.earlier_session')
        return <section key={g.key} className="agent-work-group agent-tack-group">
          <div className="agent-tack-group-heading">
            <button type="button" className="agent-work-heading" aria-expanded={open} onClick={() => toggle(g.key, defaultOpen)}>
              {open ? <AppIcon icon={ChevronDown} size="title" /> : <AppIcon icon={ChevronRight} size="title" />}
              <span><strong>{title}</strong><small>{[g.session?.client ?? g.tacks[0]?.client, t('tacks.group_count', { open: g.tacks.filter(x => x.status === 'open').length, count: g.tacks.length })].filter(Boolean).join(' · ')}</small></span>
            </button>
            <button type="button" className="agent-tack-clear" title={t('tacks.clear_session_hint')}
              onClick={() => void deleteTacks({ session_id: g.sessionId })}>{t('tacks.clear_session')}</button>
          </div>
          {open && g.tacks.map(row)}
        </section>
      })}
      <p className="agent-retention-note agent-list-footnote">{t('tacks.retention')}</p>
    </div>
  </div>
}
