import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, LocateFixed, RotateCcw, StickyNote, TriangleAlert, X } from 'lucide-react'
import type { TackKind, TackView } from '../../shared/agent-activity'
import { formatTimecode } from '../frames'
import { groupDisplayName, groupOrdinals } from '../lib/layerName'
import { useProjectStore } from '../state/projectStore'
import { AppIcon } from '@/components/AppIcon'
import { tackClosedKey, tackGroupKey, tackRowKey, useAgentActivity } from './activityStore'
import { setReviewFocus, setReviewHover, useReviewFocus } from './reviewFocus'
import { groupTacks, tackUnplacedReason } from './tackModel'
import { convertTackToMarker, deleteTacks, setTackStatus } from './tackActions'
import { locate } from './locate'
import { JumpButton } from './JumpButton'

const KIND_ICON: Record<TackKind, typeof StickyNote> = { note: StickyNote, issue: TriangleAlert, question: CircleHelp }
const NO_TACKS: TackView[] = []

/** The Tacks tab of the shared agent panel: what agents tacked on for review,
 *  grouped by the work session that left them. Locate is the editor's alone
 *  (ADR 0065); everything else is the same in both layouts.
 *
 *  Resolving or dismissing is a decision, not a toggle: the tack leaves its
 *  group's open list for the group's "closed" section (collapsed while the
 *  group still has open tacks), where it reads its status and can be
 *  reopened. The status is the user's answer to the agent (it reads
 *  `project://tacks`), so clearing — which drops the answer too — is tidying
 *  up, offered on the closed section only.
 *
 *  A row's click focuses its tack (the review focus, shared with the
 *  timelines: its chip, its range, the clip it follows), and hovering it
 *  outlines its chip. A tack whose composition is gone sorts to the foot of
 *  its list; it can only be closed or cleared. */
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
          {x.status !== 'open' && <span className="agent-tack-status">{t(`tacks.status_${x.status}`)}</span>}
          {open ? <AppIcon icon={ChevronDown} size="body" /> : <AppIcon icon={ChevronRight} size="body" />}
        </button>
        {editor ? <button type="button" aria-label={t('tacks.locate')} title={why ?? t('tacks.locate')} disabled={reason !== null}
          onClick={() => { focusThis(); locate({ kind: 'tack', tack: x }) }}><AppIcon icon={LocateFixed} size="body" /></button>
          : <JumpButton item={{ kind: 'tack', tack: x }} why={why} onJump={focusThis} />}
        {x.status === 'open' ? <>
          <button type="button" aria-label={t('tacks.resolve')} title={t('tacks.resolve_hint')}
            onClick={() => void setTackStatus([x.id], 'resolved')}><AppIcon icon={Check} size="body" /></button>
          <button type="button" aria-label={t('tacks.dismiss')} title={t('tacks.dismiss_hint')}
            onClick={() => void setTackStatus([x.id], 'dismissed')}><AppIcon icon={X} size="body" /></button>
        </> : <button type="button" aria-label={t('tacks.reopen')} title={t('tacks.reopen')}
          onClick={() => void setTackStatus([x.id], 'open')}><AppIcon icon={RotateCcw} size="body" /></button>}
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
        empty list's message already says what lands here. */}
    <div className="agent-activity-list" ref={list}>
      {!groups.length && (ready
        ? <div className="agent-empty"><p>{t('tacks.empty')}</p><p className="agent-empty-subtitle">{t('tacks.retention')}</p></div>
        : <p className="agent-empty">{t('agent_panel.loading')}</p>)}
      {groups.map(g => {
        const pending = g.tacks.filter(x => x.status === 'open')
        const closed = g.tacks.filter(x => x.status !== 'open')
        const defaultOpen = pending.length > 0
        const open = expanded[g.key] ?? defaultOpen
        const closedKey = tackClosedKey(g.sessionId)
        const closedOpen = expanded[closedKey] ?? !defaultOpen
        const title = g.session?.reason ?? t(g.sessionId === null ? 'tacks.outside_session' : 'tacks.earlier_session')
        return <section key={g.key} className="agent-work-group agent-tack-group">
          <div className="agent-tack-group-heading">
            <button type="button" className="agent-work-heading" aria-expanded={open} onClick={() => toggle(g.key, defaultOpen)}>
              {open ? <AppIcon icon={ChevronDown} size="title" /> : <AppIcon icon={ChevronRight} size="title" />}
              <span><strong>{title}</strong><small>{[g.session?.client ?? g.tacks[0]?.client, t('tacks.group_count', { open: pending.length, count: g.tacks.length })].filter(Boolean).join(' · ')}</small></span>
            </button>
            {pending.length > 0 && <button type="button" className="agent-tack-group-action" title={t('tacks.resolve_all_hint')}
              onClick={() => void setTackStatus(pending.map(x => x.id), 'resolved')}><AppIcon icon={CheckCheck} size="body" />{t('tacks.resolve_all')}</button>}
          </div>
          {open && pending.map(row)}
          {open && closed.length > 0 && <div className="agent-tack-closed">
            <div className="agent-tack-closed-heading">
              <button type="button" className="agent-tack-closed-toggle" aria-expanded={closedOpen} onClick={() => toggle(closedKey, !defaultOpen)}>
                {closedOpen ? <AppIcon icon={ChevronDown} size="body" /> : <AppIcon icon={ChevronRight} size="body" />}
                {t('tacks.closed_section', { count: closed.length })}</button>
              <button type="button" className="agent-tack-group-action" title={t('tacks.clear_closed_hint')}
                onClick={() => void deleteTacks({ tack_ids: closed.map(x => x.id) })}>{t('tacks.clear_closed')}</button>
            </div>
            {closedOpen && closed.map(row)}
          </div>}
        </section>
      })}
      {groups.length > 0 && <p className="agent-retention-note agent-list-footnote">{t('tacks.retention')}</p>}
    </div>
  </div>
}
