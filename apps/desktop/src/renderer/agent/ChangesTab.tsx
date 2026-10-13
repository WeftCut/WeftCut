import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CheckCheck, LocateFixed } from 'lucide-react'
import type { Change } from '../../shared/review'
import { formatTimecode } from '../frames'
import { groupDisplayName, layerDisplayName } from '../lib/layerName'
import { trackDisplayName } from '../lib/trackName'
import { useProjectStore } from '../state/projectStore'
import { AppIcon } from '@/components/AppIcon'
import { approveAllChanges, approveChanges, useReview, useReviewView } from './reviewStore'
import { formatShiftSeconds, groupChanges, keyIds, type ChangeRow } from './changeModel'
import { canLocateChange, locateChange } from './changeActions'

/** The Changes tab of the shared agent panel (ADR 0115): what differs from the
 *  Review baseline because an agent touched it, grouped by composition and in
 *  timeline order. Approve one or all; locate is the editor's alone (ADR 0065).
 *
 *  "Show my changes" lists the differences only the user made, too. They need
 *  no approval — the baseline is what the user accepted, and their own edits
 *  are accepted by making them — so their rows are muted, marked as the
 *  user's, and carry no approve button. */
export function ChangesTab({ editor }: { editor: boolean }) {
  const { t } = useTranslation()
  const view = useReviewView()
  const showUser = useReview(s => s.showUser)
  const summary = useProjectStore(s => s.summary)
  const layers = useProjectStore(s => s.layerById)
  const ordinals = useProjectStore(s => s.groupOrdinals)
  const [busy, setBusy] = useState(false)
  const unreviewed = view?.unreviewed ?? []
  const groups = useMemo(
    () => (view ? groupChanges(view.unreviewed, showUser ? view.user : [], summary?.root_id ?? null) : []),
    [view, showUser, summary?.root_id])

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
    if (c.class === 'shifted') {
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

  /** The one-line description of what changed. */
  const describe = (c: Change): string => {
    if (c.class === 'shifted') return t('changes.shifted_by', { delta: formatShiftSeconds(c.delta_us ?? 0) })
    const aspects = c.aspects.filter(a => !(c.class === 'moved' && a === 'placement')).map(a => t(`changes.aspect_${a}`))
    if (c.class === 'moved') {
      const where = c.to && c.from && c.to.composition_id !== c.from.composition_id ? t('changes.moved_composition') : t('changes.moved_track')
      return [where, ...aspects].join(' · ')
    }
    if (c.class === 'modified') return aspects.join(' · ')
    return t(`changes.kind_${c.kind}`)
  }

  const time = (c: Change): string | null => {
    const r = c.ranges.find(x => x.composition_id === c.composition_id) ?? c.ranges[0]
    const comp = r ? summary?.compositions[r.composition_id] : undefined
    if (!r || !comp) return null
    const start = formatTimecode(r.t_start_us, comp.fps_num, comp.fps_den)
    return r.t_end_us > r.t_start_us ? `${start} – ${formatTimecode(r.t_end_us, comp.fps_num, comp.fps_den)}` : start
  }

  const row = ({ change: c, source }: ChangeRow) => {
    const when = time(c)
    const locatable = editor && canLocateChange(c)
    return <article key={`${source}-${c.id}`} data-change-id={c.id} data-source={source} className={`agent-change class-${c.class} source-${source}`}>
      <div className="agent-tack-row">
        <span className={`agent-change-badge class-${c.class}`}>{t(`changes.class_${c.class}`)}</span>
        <span className="agent-activity-copy agent-change-copy"><span>{title(c)}</span>
          <small>{[describe(c), when].filter(Boolean).join(' · ')}</small></span>
        {source === 'user' && <span className="agent-change-mine" title={t('changes.mine_hint')}>{t('changes.mine')}</span>}
        {editor && <button type="button" aria-label={t('changes.locate')} title={t('changes.locate')} disabled={!locatable}
          onClick={() => locateChange(c)}><AppIcon icon={LocateFixed} size="body" /></button>}
        {source === 'agent' && <button type="button" aria-label={t('changes.approve')} title={t('changes.approve_hint')} disabled={busy}
          onClick={() => void approve(() => approveChanges([c.id]))}><AppIcon icon={Check} size="body" /></button>}
      </div>
    </article>
  }

  const userCount = view?.user.length ?? 0
  const empty = !view ? 'agent_panel.loading' : !view.has_baseline ? 'changes.no_baseline' : 'changes.empty'
  return <div className="agent-tacks agent-changes" role="tabpanel" aria-label={t('agent_panel.tab_changes')}>
    <p className="agent-tacks-subtitle">{t('changes.subtitle')}</p>
    <div className="agent-activity-toolbar">
      <span className="agent-tacks-count">{t('changes.unreviewed_count', { count: unreviewed.length })}</span>
      <button type="button" aria-pressed={showUser} title={t('changes.show_mine_hint')}
        onClick={() => useReview.setState({ showUser: !showUser })}>{t('changes.show_mine', { count: userCount })}</button>
      <button type="button" className="agent-changes-approve-all" disabled={busy || unreviewed.length === 0} title={t('changes.approve_all_hint')}
        onClick={() => void approve(approveAllChanges)}><AppIcon icon={CheckCheck} size="body" />{t('changes.approve_all')}</button>
    </div>
    <div className="agent-activity-list">
      {!groups.length && <p className="agent-empty">{t(empty)}</p>}
      {groups.map(g => <section key={g.compositionId ?? 'project'} className="agent-work-group agent-change-group">
        <h3 className="agent-change-group-heading"><span>{compositionName(g.compositionId)}</span>
          <small>{t('changes.group_count', { count: g.rows.filter(r => r.source === 'agent').length })}</small></h3>
        {g.rows.map(row)}
      </section>)}
    </div>
    <footer className="agent-retention-note" title={t('changes.retention')}>{t('changes.retention')}</footer>
  </div>
}
