import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, AlertCircle, Loader2, ChevronDown, ChevronRight, Lock, Settings, LocateFixed, Highlighter, X } from 'lucide-react'
import { invoke } from '@/bridge/ipc'
import type { AgentActivity, AgentConnectionSnapshot } from '../../shared/agent-activity'
import { agentSessionEnd, projectRestoreCheckpoint, type HistoryEntityRef } from '../ipc'
import { tryMutate } from '../errors/tryMutate'
import { useProjectStore } from '../state/projectStore'
import { revealAffected } from '../history/historyLinkage'
import { formatClock } from '../history/historyRows'
import { AppDialog } from '../components/AppDialog'
import { AgentSection } from '../settings/AgentSection'
import { AGENT_PANEL_TABS, useAgentActivity, type AgentPanelTab } from './activityStore'
import { releaseFocus, useReviewFocus } from './reviewFocus'
import { TacksTab } from './TacksTab'
import { ChangesTab } from './ChangesTab'
import { clearActivityChanges, showActivityChanges, useActivityHighlightHost, useReview, useUnreviewedCount } from './reviewStore'
import { buildActivitySections, type ActivityRow } from './activityRows'
import { sessionSectionKey, sessionSectionOpenByDefault } from './expansion'
import './activity.css'
import { AppIcon } from "@/components/AppIcon";

/** Shared activity surface; only the editor offers object navigation. */
export function AgentPanel({ editor = false }: { editor?: boolean }) {
  const { t } = useTranslation()
  const snapshot = useAgentActivity(s => s.snapshot)
  const ready = useAgentActivity(s => s.ready)
  const filter = useAgentActivity(s => s.filter)
  const expanded = useAgentActivity(s => s.expanded)
  const following = useAgentActivity(s => s.following)
  const toggle = useAgentActivity(s => s.toggle)
  const tab = useAgentActivity(s => s.tab)
  const openTacks = useAgentActivity(s => s.snapshot?.tacks.filter(x => x.status === 'open').length ?? 0)
  // The panel reads the Review view while mounted: the Changes tab's badge
  // counts it whichever tab is showing.
  const unreviewed = useUnreviewedCount()
  // The selected row's own changes on the timelines (spec Part B,
  // per-activity highlight); the store follows expansion and tab.
  useActivityHighlightHost()
  const shown = useReview(s => s.activity)
  const project = useProjectStore(s => s.summary)
  const layers = useProjectStore(s => s.layerById)
  const list = useRef<HTMLDivElement>(null)
  const [connections, setConnections] = useState<AgentConnectionSnapshot | null>(null)
  const [settings, setSettings] = useState(false)
  const actionPending = useRef(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    let disposed = false, pending = false
    const refresh = async () => {
      setNow(Date.now())
      if (pending) return
      pending = true
      try { const value = await invoke<AgentConnectionSnapshot>('agent_connections'); if (!disposed) setConnections(value) }
      catch { if (!disposed) setConnections(null) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => { disposed = true; clearInterval(timer) }
  }, [])
  const sections = useMemo(() => buildActivitySections((snapshot?.activities ?? []).filter(a => filter === 'all' || a.state === 'error')), [snapshot?.activities, filter])
  const session = snapshot?.session
  const running = snapshot?.activities.filter(a => a.state === 'running').length ?? 0
  const locked = snapshot?.lock_reason != null
  useLayoutEffect(() => {
    const el = list.current, state = useAgentActivity.getState()
    if (!el) return
    if (state.following) { el.scrollTop = el.scrollHeight; return }
    const anchor = state.anchor
    if (!anchor) return
    const row = Array.from(el.querySelectorAll<HTMLElement>('[data-agent-anchor]')).find(r => r.dataset.agentAnchor === anchor.id)
    if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset
  }, [sections, expanded, following, tab])
  const onScroll = () => {
    const el = list.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const first = Array.from(el.querySelectorAll<HTMLElement>('[data-agent-anchor]')).find(r => r.getBoundingClientRect().bottom > top)
    useAgentActivity.setState({ following: el.scrollHeight - el.clientHeight - el.scrollTop < 24,
      anchor: first ? { id: first.dataset.agentAnchor!, offset: first.getBoundingClientRect().top - top } : null })
  }
  const action = async (key: string, fn: () => Promise<unknown>) => {
    if (actionPending.current) return
    actionPending.current = true
    setBusy(key)
    try { await tryMutate(fn, key) } finally { actionPending.current = false; setBusy(null) }
  }
  const entry = (a: AgentActivity) => {
    const open = expanded[a.id] ?? false
    const label = a.kind === 'restore' ? t('agent_panel.restored', { label: a.message }) : a.kind === 'checkpoint' ? a.message
      : a.label_key ? t(a.label_key, a.label_args ?? {}) : t(`agent_panel.tools.${a.tool}`, { defaultValue: a.tool.replaceAll('_', ' ').replaceAll('/', ' · ') })
    const names = a.entity_labels.map(n => 'text' in n ? n.text : t(n.label_key, n.label_args ?? {})).join(' · ')
    const elapsed = a.duration_ms ?? Math.max(0, now - Date.parse(a.started_at))
    const refs = a.affected.filter((r): r is HistoryEntityRef => r.kind === 'Layer' || r.kind === 'Track' || r.kind === 'Marker')
    const canReveal = refs.some(r => r.kind === 'Layer' ? layers.has(r.id) : r.kind === 'Track' && Object.values(project?.compositions ?? {}).some(c => c.tracks.some(track => track.id === r.id)))
    const valid = snapshot?.checkpoints.some(cp => cp.id === a.checkpoint_id) ?? false
    const Icon = a.state === 'running' ? Loader2 : a.state === 'error' ? AlertCircle : Check
    return <article key={a.id} data-agent-anchor={a.id} className={`agent-activity state-${a.state}`}>
      <button type="button" className="agent-activity-main" aria-expanded={open} onClick={() => toggle(a.id)}>
        <AppIcon icon={Icon} size="title" className={a.state === 'running' ? 'agent-spin' : ''} aria-hidden />
        <span className="agent-activity-copy"><span>{label}</span>{names && <small>{names}</small>}</span>
        <span className="agent-activity-meta">{elapsed >= 250 ? `${(elapsed / 1000).toFixed(1)}s` : formatClock(a.started_at)}</span>
        {open ? <AppIcon icon={ChevronDown} size="body" /> : <AppIcon icon={ChevronRight} size="body" />}
      </button>
      <div className="agent-activity-status"><span>{t(`agent_panel.${a.state}`)}</span>
        {(a.effect === 'reverted' || a.effect === 'partial') && <span className="agent-effect">{t(`agent_panel.${a.effect}`)}</span>}</div>
      {a.error && <p className="agent-activity-error">{a.error}</p>}
      {a.kind === 'checkpoint' && <div className="agent-activity-actions"><button type="button" disabled={!valid || locked || busy !== null}
        title={!valid ? t('agent_panel.checkpoint_missing') : locked ? t('agent_panel.locked') : t('agent_mode.restore_hint')}
        onClick={() => void action('project_restore_checkpoint', () => projectRestoreCheckpoint(a.checkpoint_id!))}>{valid ? t('agent_mode.restore') : t('agent_panel.checkpoint_missing')}</button></div>}
      {open && <div className="agent-activity-details"><dl>
        <dt>{t('agent_panel.client')}</dt><dd>{a.client || t('agent_panel.user')}</dd><dt>{t('agent_panel.tool')}</dt><dd>{a.tool}</dd>
        <dt>{t('agent_panel.time')}</dt><dd>{formatClock(a.started_at)}</dd></dl>
        {a.history_ids.length > 0 && (shown?.activityId !== a.id
          ? <button type="button" onClick={() => void showActivityChanges(a)}><AppIcon icon={Highlighter} size="body" /> {t('agent_panel.show_changes')}</button>
          : shown.status === 'unavailable' ? <p className="agent-activity-note">{t('agent_panel.changes_unavailable')}</p>
          : shown.status === 'ready' && shown.count === 0 ? <p className="agent-activity-note">{t('agent_panel.changes_none')}</p> : null)}
        {editor && refs.length > 0 && <button type="button" disabled={!canReveal} onClick={() => revealAffected(refs)}><AppIcon icon={LocateFixed} size="body" /> {canReveal ? t('agent_panel.locate') : t('agent_panel.object_missing')}</button>}
        <details><summary>{t('agent_panel.arguments')}</summary><pre>{JSON.stringify(a.args, null, 2)}</pre></details>
      </div>}
    </article>
  }
  const row = (r: ActivityRow) => r.kind === 'activity' ? entry(r.activity) : <div key={`reads-${r.id}`} data-agent-anchor={`reads-${r.id}`} className="agent-read-group">
    <button type="button" aria-expanded={expanded[`reads-${r.id}`] ?? false} onClick={() => toggle(`reads-${r.id}`)}>
      {expanded[`reads-${r.id}`] ? <AppIcon icon={ChevronDown} size="label" /> : <AppIcon icon={ChevronRight} size="label" />}{t('agent_panel.reads', { count: r.activities.length })}</button>
    {expanded[`reads-${r.id}`] && r.activities.map(entry)}</div>
  /** A tab's count badge: open tacks, unreviewed changes; nothing for Activity. */
  const badge = (id: AgentPanelTab) => id === 'tacks' ? openTacks : id === 'changes' ? unreviewed : 0
  // Esc lets the review focus go — from inside the panel only. Everywhere else
  // Esc already has owners (blade and region arms, the inline track reveal, a
  // maximised panel's restore), and a focus that vanished as one of those was
  // dismissed would be a second, unasked-for effect. Here it is the nearest
  // thing to dismiss, so it is consumed. A portalled dialog's keys bubble
  // through React to here but are not inside this box, and are its own.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return
    if (useReviewFocus.getState().focus === null) return
    e.preventDefault()
    e.stopPropagation()
    releaseFocus()
  }
  return <div className="agent-panel agent-activity-panel" onKeyDown={onKeyDown}>
    {/* One status row: the service (its toggle opens the connection details),
        then the active work session's reason — or, outside one, what is
        running — and the session's End beside the settings. */}
    <header className="agent-status-row">
      <button type="button" className="agent-connection-toggle" aria-expanded={expanded.connections ?? false} onClick={() => toggle('connections')}>
        <span className={`agent-service-dot ${connections?.available ? 'available' : ''}`} /><span>{t(connections === null ? 'agent_panel.service_unknown' : connections.available ? 'agent_panel.service_ready' : 'agent_panel.service_offline')}</span>
        {expanded.connections ? <AppIcon icon={ChevronDown} size="label" /> : <AppIcon icon={ChevronRight} size="label" />}</button>
      <span className="agent-status-sep" aria-hidden>·</span>
      <span className={`agent-live-state${session ? ' session' : ''}`} role="status" title={session ? `${session.client} · ${session.reason}` : undefined}>
        {session ? session.reason : running ? t('agent_panel.running_count', { count: running }) : t('agent_panel.no_running')}</span>
      {session && <button type="button" className="agent-session-end" disabled={busy !== null} aria-label={t('agent_panel.end_session')} title={t('agent_panel.end_hint')} aria-description={t('agent_panel.end_hint')}
        onClick={() => void action('agent_session_end', agentSessionEnd)}>{t('agent_panel.end_short')}</button>}
      <button type="button" aria-label={t('agent_panel.connection_settings')} title={t('agent_panel.connection_settings')} onClick={() => setSettings(true)}><AppIcon icon={Settings} size="title" /></button></header>
    {expanded.connections && <div className="agent-connection-details"><code>{connections?.url ?? '—'}</code>
      {connections?.connections.length ? connections.connections.map(c => <div key={c.id}><strong>{c.client} {c.version}</strong><small>{t('agent_panel.last_activity', { time: formatClock(c.last_activity_at) })}</small></div>) : <p>{t('agent_panel.no_connections')}</p>}
      <small>{t('agent_panel.connection_note')}</small></div>}
    {locked && <div className="agent-history-lock"><AppIcon icon={Lock} size="label" /><span title={snapshot?.lock_reason || t('agent_panel.locked')}>{snapshot?.lock_reason || t('agent_panel.locked')}</span><button type="button" disabled={busy !== null} onClick={() => void action('agent_unlock_history', () => invoke('agent_unlock_history'))}>{t('agent_panel.unlock')}</button></div>}
    {/* One tab per review surface. Content below the bar belongs to the tab;
        the status and lock rows above it hold for every tab. */}
    <div className="agent-panel-tabs" role="tablist" aria-label={t('agent_panel.tabs')}>
      {AGENT_PANEL_TABS.map(id => <button type="button" role="tab" key={id} aria-selected={tab === id}
        title={id === 'tacks' ? t('tacks.subtitle') : id === 'changes' ? t('changes.subtitle') : undefined}
        onClick={() => useAgentActivity.setState({ tab: id })}>{t(`agent_panel.tab_${id}`)}{badge(id) > 0 && <span className={`agent-panel-tab-count tab-${id}`}>{badge(id)}</span>}</button>)}
    </div>
    {tab === 'tacks' ? <TacksTab editor={editor} /> : tab === 'changes' ? <ChangesTab editor={editor} /> : <>
    <div className="agent-activity-toolbar" role="group" aria-label={t('agent_panel.filter')}>
      {(['all', 'errors'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => useAgentActivity.setState({ filter: value })}>{t(`agent_panel.filter_${value}`)}</button>)}
      {!following && <button type="button" onClick={() => useAgentActivity.setState({ following: true, anchor: null })}>{t('agent_panel.latest')}</button>}</div>
    {shown?.status === 'ready' && <div className="agent-activity-highlight" role="status"><AppIcon icon={Highlighter} size="label" aria-hidden />
      <span>{t(shown.reverted ? 'agent_panel.highlight_reverted' : 'agent_panel.highlight_active', { count: shown.count })}</span>
      <button type="button" aria-label={t('agent_panel.highlight_clear')} title={t('agent_panel.highlight_clear')} onClick={clearActivityChanges}><AppIcon icon={X} size="label" /></button></div>}
    <div className="agent-activity-list" ref={list} onScroll={onScroll}>
      {!!snapshot?.evicted && <p className="agent-retention-note">{t('agent_panel.truncated', { count: snapshot.evicted })}</p>}
      {!sections.length && (ready
        ? <div className="agent-empty"><p>{t(filter === 'errors' ? 'agent_panel.no_errors' : 'agent_panel.empty')}</p><p className="agent-empty-subtitle">{t('agent_panel.retention')}</p></div>
        : <p className="agent-empty">{t('agent_panel.loading')}</p>)}
      {sections.map(section => {
        const work = snapshot?.sessions.find(s => s.id === section.sessionId)
        if (!work) return <div key={section.id}>{section.rows.map(row)}</div>
        const key = sessionSectionKey(section)
        const defaultOpen = filter === 'errors' || sessionSectionOpenByDefault(section, snapshot?.sessions ?? [])
        const open = expanded[key] ?? defaultOpen
        const count = section.rows.reduce((sum, r) => sum + (r.kind === 'reads' ? r.activities.length : 1), 0)
        const failure = section.rows.some(r => r.kind === 'activity' && r.activity.state === 'error')
        return <section key={section.id} className="agent-work-group" data-agent-anchor={key}>
          <button type="button" className="agent-work-heading" aria-expanded={open} onClick={() => toggle(key, defaultOpen)}>
            {open ? <AppIcon icon={ChevronDown} size="title" /> : <AppIcon icon={ChevronRight} size="title" />}<span><strong>{work.reason}</strong><small>{work.client} · {t('agent_panel.operation_count', { count })}</small></span>
            {failure && <AppIcon icon={AlertCircle} size="label" className="agent-activity-error" />}<small>{t(work.end_reason === 'disconnected' ? 'agent_panel.disconnected' : work.ended_at ? 'agent_panel.session_ended' : 'agent_panel.session_active')}</small></button>
          {open && section.rows.map(row)}</section>
      })}
      {sections.length > 0 && <p className="agent-retention-note agent-list-footnote">{t('agent_panel.retention')}</p>}</div></>}
    {settings && <AppDialog title={t('agent_panel.connection_settings')} onClose={() => setSettings(false)} panelClassName="agent-connect-dialog"><div className="agent-connect-dialog-body"><AgentSection /></div></AppDialog>}
  </div>
}
