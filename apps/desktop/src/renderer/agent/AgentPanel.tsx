import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Check, AlertCircle, Loader2, ChevronDown, ChevronRight, Lock, Settings, LocateFixed } from 'lucide-react'
import { invoke } from '@/bridge/ipc'
import type { AgentActivity, AgentConnectionSnapshot } from '../../shared/agent-activity'
import { agentSessionEnd, projectRestoreCheckpoint, type HistoryEntityRef } from '../ipc'
import { tryMutate } from '../errors/tryMutate'
import { useProjectStore } from '../state/projectStore'
import { revealAffected } from '../history/historyLinkage'
import { formatClock } from '../history/historyRows'
import { AppDialog } from '../components/AppDialog'
import { AgentSection } from '../settings/AgentSection'
import { useAgentActivity } from './activityStore'
import { buildActivitySections, type ActivityRow } from './activityRows'
import './activity.css'

/** Shared activity surface; only the editor offers object navigation. */
export function AgentPanel({ editor = false }: { editor?: boolean }) {
  const { t } = useTranslation()
  const snapshot = useAgentActivity(s => s.snapshot)
  const ready = useAgentActivity(s => s.ready)
  const filter = useAgentActivity(s => s.filter)
  const expanded = useAgentActivity(s => s.expanded)
  const following = useAgentActivity(s => s.following)
  const toggle = useAgentActivity(s => s.toggle)
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
  }, [sections, expanded, following])
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
        <Icon size={14} className={a.state === 'running' ? 'agent-spin' : ''} aria-hidden />
        <span className="agent-activity-copy"><span>{label}</span>{names && <small>{names}</small>}</span>
        <span className="agent-activity-meta">{elapsed >= 250 ? `${(elapsed / 1000).toFixed(1)}s` : formatClock(a.started_at)}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
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
        {editor && refs.length > 0 && <button type="button" disabled={!canReveal} onClick={() => revealAffected(refs)}><LocateFixed size={12} /> {canReveal ? t('agent_panel.locate') : t('agent_panel.object_missing')}</button>}
        <details><summary>{t('agent_panel.arguments')}</summary><pre>{JSON.stringify(a.args, null, 2)}</pre></details>
      </div>}
    </article>
  }
  const row = (r: ActivityRow) => r.kind === 'activity' ? entry(r.activity) : <div key={`reads-${r.id}`} data-agent-anchor={`reads-${r.id}`} className="agent-read-group">
    <button type="button" aria-expanded={expanded[`reads-${r.id}`] ?? false} onClick={() => toggle(`reads-${r.id}`)}>
      {expanded[`reads-${r.id}`] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{t('agent_panel.reads', { count: r.activities.length })}</button>
    {expanded[`reads-${r.id}`] && r.activities.map(entry)}</div>
  return <div className="agent-panel agent-activity-panel">
    <header className="agent-connection-header"><button type="button" className="agent-connection-toggle" aria-expanded={expanded.connections ?? false} onClick={() => toggle('connections')}>
      <span className={`agent-service-dot ${connections?.available ? 'available' : ''}`} /><span>{t(connections === null ? 'agent_panel.service_unknown' : connections.available ? 'agent_panel.service_ready' : 'agent_panel.service_offline')}</span>
      {expanded.connections ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
      <button type="button" aria-label={t('agent_panel.connection_settings')} title={t('agent_panel.connection_settings')} onClick={() => setSettings(true)}><Settings size={14} /></button></header>
    {expanded.connections && <div className="agent-connection-details"><code>{connections?.url ?? '—'}</code>
      {connections?.connections.length ? connections.connections.map(c => <div key={c.id}><strong>{c.client} {c.version}</strong><small>{t('agent_panel.last_activity', { time: formatClock(c.last_activity_at) })}</small></div>) : <p>{t('agent_panel.no_connections')}</p>}
      <small>{t('agent_panel.connection_note')}</small></div>}
    <div className="agent-live-state" role="status"><Bot size={14} /><span>{running ? t('agent_panel.running_count', { count: running }) : t('agent_panel.no_running')}</span></div>
    {session && <section className="agent-session-header"><strong>{session.client}</strong><p>{session.reason}</p>
      <button type="button" disabled={busy !== null} title={t('agent_panel.end_hint')} aria-description={t('agent_panel.end_hint')} onClick={() => void action('agent_session_end', agentSessionEnd)}>{t('agent_panel.end_session')}</button></section>}
    {locked && <div className="agent-history-lock"><Lock size={13} /><span>{snapshot?.lock_reason || t('agent_panel.locked')}</span><button type="button" disabled={busy !== null} onClick={() => void action('agent_unlock_history', () => invoke('agent_unlock_history'))}>{t('agent_panel.unlock')}</button></div>}
    <div className="agent-activity-toolbar" role="group" aria-label={t('agent_panel.filter')}>
      {(['all', 'errors'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => useAgentActivity.setState({ filter: value })}>{t(`agent_panel.filter_${value}`)}</button>)}
      {!following && <button type="button" onClick={() => useAgentActivity.setState({ following: true, anchor: null })}>{t('agent_panel.latest')}</button>}</div>
    <div className="agent-activity-list" ref={list} onScroll={onScroll}>
      {!!snapshot?.evicted && <p className="agent-retention-note">{t('agent_panel.truncated', { count: snapshot.evicted })}</p>}
      {!sections.length && <p className="agent-empty">{t(!ready ? 'agent_panel.loading' : filter === 'errors' ? 'agent_panel.no_errors' : 'agent_panel.empty')}</p>}
      {sections.map(section => {
        const work = snapshot?.sessions.find(s => s.id === section.sessionId)
        if (!work) return <div key={section.id}>{section.rows.map(row)}</div>
        const key = `session-${section.id}`
        const defaultOpen = work.ended_at === null || filter === 'errors' || section.rows.some(r => r.kind === 'activity' && r.activity.state === 'running')
        const open = expanded[key] ?? defaultOpen
        const count = section.rows.reduce((sum, r) => sum + (r.kind === 'reads' ? r.activities.length : 1), 0)
        const failure = section.rows.some(r => r.kind === 'activity' && r.activity.state === 'error')
        return <section key={section.id} className="agent-work-group" data-agent-anchor={key}>
          <button type="button" className="agent-work-heading" aria-expanded={open} onClick={() => toggle(key, defaultOpen)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span><strong>{work.reason}</strong><small>{work.client} · {t('agent_panel.operation_count', { count })}</small></span>
            {failure && <AlertCircle size={13} className="agent-activity-error" />}<small>{t(work.end_reason === 'disconnected' ? 'agent_panel.disconnected' : work.ended_at ? 'agent_panel.session_ended' : 'agent_panel.session_active')}</small></button>
          {open && section.rows.map(row)}</section>
      })}</div>
    <footer className="agent-retention-note" title={t('agent_panel.retention')}>{t('agent_panel.retention')}</footer>
    {settings && <AppDialog title={t('agent_panel.connection_settings')} onClose={() => setSettings(false)} panelClassName="agent-connect-dialog"><div className="agent-connect-dialog-body"><AgentSection /></div></AppDialog>}
  </div>
}
