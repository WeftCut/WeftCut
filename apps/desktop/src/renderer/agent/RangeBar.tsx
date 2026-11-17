import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, ChevronLeft, ChevronRight, Play, type LucideIcon } from 'lucide-react'
import { AppIcon } from '@/components/AppIcon'
import { ACTION_DEFS, type ActionId } from '../shortcuts/defs'
import { useEffectiveBindings } from '../shortcuts/bindings-context'
import { resolveAccelerator } from '../shortcuts/match'
import { displayedFrameStartUs } from '../frames'
import { openComposition, useShownTimelineId } from '../state/compositionAnchorStore'
import { useLocalPlayheadUsThrottled } from '../state/playheadProjection'
import { useProjectStore } from '../state/projectStore'
import type { Translate } from './changeWords'
import { rangeLine, rangesTotal } from './rangeWords'
import { nextRange, playChangedRange, walkChangedRange } from './rangeWalk'
import { listedOrder, rangeKey, rangeStepsIn, releaseFocus, useReviewFocus, type ChangeSource } from './reviewFocus'
import type { ReviewRangeMark } from './reviewHighlight'
import { useCompositionChangeRanges, useReview } from './reviewStore'

const byTime = (a: ReviewRangeMark, b: ReviewRangeMark) => a.tStartUs - b.tStartUs || a.tEndUs - b.tEndUs

/** The changed ranges (ADR 0169) of the timeline on screen, at the head of
 *  the tab whose list the bands paint — the Changes tab, or the Activity tab
 *  while a selected call's are up. The one place their count and length are
 *  told: the change stat beside it counts entities, not stretches of film.
 *
 *  With no range focused it says how many there are and how long they run,
 *  and starts the review: play focuses the range under or after the
 *  playhead and plays it, the arrows walk from the playhead. In a Group's
 *  timeline it names the Group's own and offers the film's, which hold what
 *  every Group shows.
 *
 *  With one focused it is that range: play, what it is, and which of the
 *  timeline's ranges it is between the way to its neighbours; a press on
 *  that count goes back to all of them, as Esc does. Its
 *  changes are the framed rows below; a press on one points at it, and only
 *  then does the line say which of them it is (`· 2 / 3`). The neighbours
 *  are the same walk as Alt+↑/↓, so they seek. */
export function RangeBar({ source }: { source: ChangeSource }) {
  const { t } = useTranslation()
  const focus = useReviewFocus(s => s.focus)
  const range = useReviewFocus(s => s.range)
  const view = useReview(s => s.view)
  const showUser = useReview(s => s.showUser)
  const highlighted = useReview(s => s.activity?.status === 'ready')
  const rootId = useProjectStore(s => s.summary?.root_id ?? null)
  const shownId = useShownTimelineId()
  const listed = useMemo(() => (source === 'review' ? listedOrder(view, showUser, rootId) : []), [source, view, showUser, rootId])
  const steps = useMemo(() => (range === null ? [] : rangeStepsIn(range, source, listed)), [range, source, listed])
  const focused = focus?.kind === 'range' && focus.source === source && range !== null
  const spots = useCompositionChangeRanges(focused ? range.composition_id : shownId)
  const film = useCompositionChangeRanges(rootId)
  const order = useMemo(() => [...spots].sort(byTime), [spots])
  // The arrows' ends from the playhead, by displayed frame as the walk
  // decides them: only read while the arrows stand on it.
  const playheadUs = useLocalPlayheadUsThrottled(shownId, 100, !focused && order.length > 0)
  const comp = useProjectStore(s => (shownId === null ? undefined : s.summary?.compositions[shownId]))
  const frameOf = (us: number) => (comp === undefined ? us : displayedFrameStartUs(us, comp.fps_num, comp.fps_den))
  if (focused) {
    const key = rangeKey(range)
    const spot = order.findIndex(m => rangeKey(m.range) === key)
    const step = focus.step === null ? 0 : steps.indexOf(focus.step) + 1
    const line = rangeLine(range, t as unknown as Translate)
      + (step > 0 ? ` · ${t('changes.range_bar.step', { index: step, count: steps.length })}` : '')
    return <div className="agent-range-bar" role="group" aria-label={t('changes.range_bar.label')}>
      <PlayButton label={t('changes.range_bar.play')} />
      <span className="agent-range-bar-line" title={line}>{line}</span>
      <span className="agent-range-bar-spots">
        {spot >= 0 && <ActionButton icon={ChevronLeft} action="seekPrevChangedRange" disabled={spot === 0} onClick={() => walkChangedRange(-1)} />}
        {/* Which of the ranges this is, and the way back to all of them:
            the overview's count, narrowed. Not a close: the bar stays. */}
        <button type="button" className="agent-range-bar-spot" aria-live="polite" title={t('changes.range_bar.back', { count: order.length })}
          onClick={releaseFocus}>{spot >= 0 ? t('changes.range_bar.spot', { index: spot + 1, count: order.length }) : t('changes.range_bar.all', { count: order.length })}</button>
        {spot >= 0 && <ActionButton icon={ChevronRight} action="seekNextChangedRange" disabled={spot === order.length - 1} onClick={() => walkChangedRange(1)} />}
      </span>
    </div>
  }
  // The bands paint a selected call's ranges or the Review view's: the row
  // stands in the tab whose list they are.
  if (highlighted !== (source === 'activity')) return null
  const inGroup = shownId !== null && shownId !== rootId
  if (order.length === 0 && !(inGroup && film.length > 0)) return null
  const total = rangesTotal(order.map(m => m.range), t as unknown as Translate)
  const line = order.length === 0 ? t('changes.range_bar.group_none')
    : inGroup ? t('changes.range_bar.group_total', { total: total.short }) : total.short
  const ranges = order.map(m => m.range)
  return <div className="agent-range-bar" role="group" aria-label={t('changes.range_bar.label')}>
    {order.length > 0 && <PlayButton label={t('changes.range_bar.review')} />}
    <span className="agent-range-bar-line" title={order.length > 0 ? total.full : line}>{line}</span>
    {inGroup && film.length > 0 && rootId !== null && <button type="button" className="agent-range-bar-film"
      title={t('changes.range_bar.film_hint')} onClick={() => openComposition(rootId, null)}>
      <span>{t('changes.range_bar.film', { count: film.length })}</span><AppIcon icon={ArrowUpRight} size="body" /></button>}
    {order.length > 0 && <span className="agent-range-bar-spots">
      <ActionButton icon={ChevronLeft} action="seekPrevChangedRange" disabled={nextRange(ranges, { playheadUs }, -1, frameOf) === null} onClick={() => walkChangedRange(-1)} />
      <ActionButton icon={ChevronRight} action="seekNextChangedRange" disabled={nextRange(ranges, { playheadUs }, 1, frameOf) === null} onClick={() => walkChangedRange(1)} />
    </span>}
  </div>
}

function BarButton({ icon, label, disabled = false, onClick }: { icon: LucideIcon; label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" aria-label={label} title={label} aria-disabled={disabled || undefined}
    onClick={() => { if (!disabled) onClick() }}><AppIcon icon={icon} size="body" /></button>
}

/** The name of an action with its key, as the Quick Actions strip shows it. */
function useActionTitle(action: ActionId): string {
  const { t } = useTranslation()
  const binding = useEffectiveBindings(action)
  const name = t(ACTION_DEFS[action].labelKey)
  return binding ? `${name} (${resolveAccelerator(binding)})` : name
}

/** A bar button that is also a key: named by the action, its key beside the
 *  name. Buttons stay focusable at an end (`aria-disabled`), so a keyboard
 *  walk through them never drops focus out of the panel, where Esc steps
 *  back and then lets go. */
function ActionButton({ icon, action, disabled, onClick }: { icon: LucideIcon; action: ActionId; disabled?: boolean; onClick: () => void }) {
  return <BarButton icon={icon} label={useActionTitle(action)} disabled={disabled ?? false} onClick={onClick} />
}

/** Play, named in words: the one action of the row. */
function PlayButton({ label }: { label: string }) {
  return <button type="button" className="agent-range-bar-play" title={useActionTitle('playChangedRange')} onClick={playChangedRange}>
    <AppIcon icon={Play} size="body" /><span>{label}</span>
  </button>
}
