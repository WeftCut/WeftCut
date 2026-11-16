import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Play, X, type LucideIcon } from 'lucide-react'
import { AppIcon } from '@/components/AppIcon'
import { ACTION_DEFS, type ActionId } from '../shortcuts/defs'
import { useEffectiveBindings } from '../shortcuts/bindings-context'
import { resolveAccelerator } from '../shortcuts/match'
import { useProjectStore } from '../state/projectStore'
import type { Translate } from './changeWords'
import { rangeLine } from './rangeWords'
import { playChangedRange, walkChangedRange } from './rangeWalk'
import { listedOrder, rangeKey, rangeStepsIn, releaseFocus, useReviewFocus, type ChangeSource } from './reviewFocus'
import { useCompositionChangeRanges, useReview } from './reviewStore'

/** The focused changed range (ADR 0169) at the head of the tab that lists
 *  it — the Changes tab, or the Activity tab for a selected call's: one flat
 *  row of play, what the range is, which of the timeline's ranges it is with
 *  the way to its neighbours, and close.
 *
 *  Playing is what reviewing a range mostly is, so it leads and is named.
 *  Its changes are the framed rows below; a press on one points at it, and
 *  only then does the line say which of them it is (`· 2 / 3`). The
 *  neighbours are the same walk as Alt+↑/↓, so they seek. */
export function RangeBar({ source }: { source: ChangeSource }) {
  const { t } = useTranslation()
  const focus = useReviewFocus(s => s.focus)
  const range = useReviewFocus(s => s.range)
  const view = useReview(s => s.view)
  const showUser = useReview(s => s.showUser)
  const rootId = useProjectStore(s => s.summary?.root_id ?? null)
  const listed = useMemo(() => (source === 'review' ? listedOrder(view, showUser, rootId) : []), [source, view, showUser, rootId])
  const steps = useMemo(() => (range === null ? [] : rangeStepsIn(range, source, listed)), [range, source, listed])
  const spots = useCompositionChangeRanges(range?.composition_id ?? null)
  if (focus?.kind !== 'range' || focus.source !== source || range === null) return null
  const key = rangeKey(range)
  const order = [...spots].sort((a, b) => a.tStartUs - b.tStartUs || a.tEndUs - b.tEndUs)
  const spot = order.findIndex(m => rangeKey(m.range) === key)
  const step = focus.step === null ? 0 : steps.indexOf(focus.step) + 1
  const line = rangeLine(range, t as unknown as Translate)
    + (step > 0 ? ` · ${t('changes.range_bar.step', { index: step, count: steps.length })}` : '')
  return <div className="agent-range-bar" role="group" aria-label={t('changes.range_bar.label')}>
    <PlayButton />
    <span className="agent-range-bar-line" title={line}>{line}</span>
    {spot >= 0 && <span className="agent-range-bar-spots">
      <ActionButton icon={ChevronLeft} action="seekPrevChangedRange" disabled={spot === 0} onClick={() => walkChangedRange(-1)} />
      <span className="agent-range-bar-spot" aria-live="polite">{t('changes.range_bar.spot', { index: spot + 1, count: order.length })}</span>
      <ActionButton icon={ChevronRight} action="seekNextChangedRange" disabled={spot === order.length - 1} onClick={() => walkChangedRange(1)} />
    </span>}
    <BarButton icon={X} label={t('changes.range_bar.close')} onClick={releaseFocus} />
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
function PlayButton() {
  const { t } = useTranslation()
  return <button type="button" className="agent-range-bar-play" title={useActionTitle('playChangedRange')} onClick={playChangedRange}>
    <AppIcon icon={Play} size="body" /><span>{t('changes.range_bar.play')}</span>
  </button>
}
