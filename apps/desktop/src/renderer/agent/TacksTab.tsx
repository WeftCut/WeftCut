import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, CircleHelp, LocateFixed, StickyNote, TriangleAlert, X } from 'lucide-react'
import type { TackKind, TackView } from '../../shared/agent-activity'
import { formatTimecode } from '../frames'
import { groupDisplayName, groupOrdinals } from '../lib/layerName'
import { useProjectStore } from '../state/projectStore'
import { AppIcon } from '@/components/AppIcon'
import { tackGroupKey, tackRowKey, useAgentActivity } from './activityStore'
import { groupTacks, tackUnplacedReason } from './tackModel'
import { convertTackToMarker, deleteTacks, locateTack, setTackStatus } from './tackActions'

const KIND_ICON: Record<TackKind, typeof StickyNote> = { note: StickyNote, issue: TriangleAlert, question: CircleHelp }
const NO_TACKS: TackView[] = []

/** The Tacks tab of the shared agent panel: what agents tacked on for review,
 *  grouped by the work session that left them. Locate is the editor's alone
 *  (ADR 0065); everything else is the same in both layouts. */
export function TacksTab({ editor }: { editor: boolean }) {
  const { t } = useTranslation()
  const tacks = useAgentActivity(s => s.snapshot?.tacks ?? NO_TACKS)
  const sessions = useAgentActivity(s => s.snapshot?.sessions)
  const ready = useAgentActivity(s => s.ready)
  const expanded = useAgentActivity(s => s.expanded)
  const toggle = useAgentActivity(s => s.toggle)
  const selected = useAgentActivity(s => s.selectedTack)
  const summary = useProjectStore(s => s.summary)
  const list = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => groupTacks(tacks, sessions ?? [], tackGroupKey), [tacks, sessions])
  const ordinals = useMemo(() => summary ? groupOrdinals(summary.compositions, summary.root_id) : undefined, [summary])
  const closed = tacks.filter(x => x.status !== 'open').length

  // A chip click or a locate names a tack; bring its row into view.
  useEffect(() => {
    if (selected === null) return
    const row = list.current?.querySelector<HTMLElement>(`[data-tack-id="${CSS.escape(selected)}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  const place = (x: TackView): string => {
    if (x.state === 'stale') return t('tacks.state_stale')
    if (x.state === 'hibernating') return t('tacks.state_hibernating')
    const c = x.composition_id === null ? undefined : summary?.compositions[x.composition_id]
    if (!c || x.t_us === null) return '—'
    const time = formatTimecode(x.t_us, c.fps_num, c.fps_den) + (x.end_t_us === null ? '' : ` – ${formatTimecode(x.end_t_us, c.fps_num, c.fps_den)}`)
    return c.id === summary?.root_id ? time : `${groupDisplayName(c.id, c.label, ordinals, t)} · ${time}`
  }

  const row = (x: TackView) => {
    const open = expanded[tackRowKey(x.id)] ?? false
    const reason = tackUnplacedReason(x)
    const why = reason ? t(reason) : null
    const statusToggle = (status: 'resolved' | 'dismissed') => void setTackStatus([x.id], x.status === status ? 'open' : status)
    return <article key={x.id} data-tack-id={x.id} data-selected={selected === x.id ? 'true' : undefined}
      className={`agent-tack status-${x.status} state-${x.state}`}>
      <div className="agent-tack-row">
        <button type="button" className="agent-tack-main" aria-expanded={open}
          onClick={() => { toggle(tackRowKey(x.id)); useAgentActivity.setState({ selectedTack: x.id }) }}>
          <AppIcon icon={KIND_ICON[x.kind]} size="title" className={`agent-tack-kind kind-${x.kind}`} aria-label={t(`tacks.kind_${x.kind}`)} />
          <span className="agent-activity-copy"><span>{x.label}</span><small title={why ?? undefined}>{place(x)}</small></span>
          <span className="agent-tack-status">{t(`tacks.status_${x.status}`)}</span>
          {open ? <AppIcon icon={ChevronDown} size="body" /> : <AppIcon icon={ChevronRight} size="body" />}
        </button>
        {editor && <button type="button" aria-label={t('tacks.locate')} title={why ?? t('tacks.locate')} disabled={reason !== null}
          onClick={() => { useAgentActivity.setState({ selectedTack: x.id }); locateTack(x) }}><AppIcon icon={LocateFixed} size="body" /></button>}
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
    <p className="agent-tacks-subtitle">{t('tacks.subtitle')}</p>
    <div className="agent-activity-toolbar">
      <span className="agent-tacks-count">{t('tacks.open_count', { count: tacks.filter(x => x.status === 'open').length })}</span>
      <button type="button" disabled={closed === 0} title={t('tacks.clear_closed_hint')}
        onClick={() => void deleteTacks({ statuses: ['resolved', 'dismissed'] })}>{t('tacks.clear_closed')}</button>
    </div>
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
    </div>
    <footer className="agent-retention-note" title={t('tacks.retention')}>{t('tacks.retention')}</footer>
  </div>
}
