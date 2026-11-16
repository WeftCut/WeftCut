// The words of a changed range (ADR 0169) under the pointer: what plays
// differently there and how long, in a line short enough for a tooltip. A
// range is a fact about the film, so its words are the film's — added,
// removed, modified, how many seconds — never which tool made it.
import type { ChangedRange } from '../../shared/review'
import type { Translate } from './changeWords'

/** Seconds to one decimal: a tooltip measure, not a timecode. */
function seconds(us: number, t: Translate): string {
  return t('changes.range.seconds', { value: (Math.max(0, us) / 1_000_000).toFixed(1) })
}

/** One line for range `r`. */
export function rangeLine(r: ChangedRange, t: Translate): string {
  const now = r.t_end_us - r.t_start_us, before = r.before_end_us - r.before_start_us
  let head: string
  if (r.gap) head = t(`changes.range.gap_${r.class === 'added' ? 'added' : 'removed'}`, { duration: seconds(Math.abs(now - before), t) })
  else if (r.class === 'removed') head = t(now <= 0 ? 'changes.range.cut' : 'changes.range.removed', { duration: seconds(before, t) })
  else if (r.class === 'added') head = t('changes.range.added', { duration: seconds(now, t) })
  // Nothing plays differently on its own: the stretch is one fact, its sync.
  else if (r.only === 'sync') head = t('changes.range.out_of_sync', { duration: seconds(now, t) })
  else if (before > 0 && before !== now) head = t('changes.range.modified_resized', { duration: seconds(now, t), before: seconds(before, t) })
  else head = t('changes.range.modified', { duration: seconds(now, t) })
  const notes: string[] = []
  if (r.sound_lag_us !== undefined) {
    const sound = r.sound_role ? t(`audio_roles.${r.sound_role}`, {}) : t('changes.range.sound', {})
    const key = r.sound_lag_us >= 0 ? 'changes.range.sound_later' : 'changes.range.sound_earlier'
    notes.push(t(key, { sound, lag: seconds(Math.abs(r.sound_lag_us), t) }))
  } else if (r.sync_offset_us !== undefined) notes.push(t('changes.range.sync', { offset: seconds(r.sync_offset_us, t) }))
  else if (r.only === 'audio' || r.only === 'picture') notes.push(t(`changes.range.only_${r.only}`, {}))
  if (r.source === 'user') notes.push(t('changes.range.user', {}))
  else if (r.includes_user) notes.push(t('changes.range.includes_user', {}))
  return [head, ...notes].join(' · ')
}
