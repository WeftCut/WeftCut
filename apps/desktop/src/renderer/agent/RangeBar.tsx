import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Play, X, type LucideIcon } from 'lucide-react'
import { AppIcon } from '@/components/AppIcon'
import { ACTION_DEFS, type ActionId } from '../shortcuts/defs'
import { useEffectiveBindings } from '../shortcuts/bindings-context'
import { resolveAccelerator } from '../shortcuts/match'
import { useProjectStore } from '../state/projectStore'
import type { Translate } from './changeWords'
import { rangeLine } from './rangeWords'
import { playChangedRange, walkChangedRange } from './rangeWalk'
import { listedOrder, rangeStepsIn, releaseFocus, stepRange, useReviewFocus, type ChangeSource } from './reviewFocus'
import { useReview } from './reviewStore'

/** The focused changed range (ADR 0169) at the head of the tab that lists
 *  it — the Changes tab, or the Activity tab for a selected call's: its line,
 *  a stepper through its changes, play, the neighbouring ranges, close.
 *
 *  The stepper's first position is the whole range; each next one points at
 *  one of its changes in the list's row order, the range kept as context
 *  (`stepRange`). It stops at both ends. Its buttons stay focusable at an end
 *  (`aria-disabled`), so a keyboard walk through them never drops focus out
 *  of the panel, where Esc steps back and then lets go. */
export function RangeBar({ source }: { source: ChangeSource }) {
  const { t } = useTranslation()
  const focus = useReviewFocus(s => s.focus)
  const range = useReviewFocus(s => s.range)
  const view = useReview(s => s.view)
  const showUser = useReview(s => s.showUser)
  const rootId = useProjectStore(s => s.summary?.root_id ?? null)
  const listed = useMemo(() => (source === 'review' ? listedOrder(view, showUser, rootId) : []), [source, view, showUser, rootId])
  const steps = useMemo(() => (range === null ? [] : rangeStepsIn(range, source, listed)), [range, source, listed])
  if (focus?.kind !== 'range' || focus.source !== source || range === null) return null
  const at = focus.step === null ? 0 : steps.indexOf(focus.step) + 1
  const count = steps.length
  const line = rangeLine(range, t as unknown as Translate)
  return <div className="agent-range-bar" role="group" aria-label={t('changes.range_bar.label')} data-class={range.class}
    data-cut={range.t_end_us <= range.t_start_us || undefined}>
    <span className="agent-range-bar-line" title={line}>{line}</span>
    <BarButton icon={X} label={t('changes.range_bar.close')} onClick={releaseFocus} />
    <div className="agent-range-bar-controls">
      <BarButton icon={ChevronLeft} label={t('changes.range_bar.prev_change')} disabled={at === 0} onClick={() => stepRange(-1)} />
      <span className="agent-range-step" aria-live="polite">
        {at === 0 ? t('changes.range_bar.whole', { count }) : t('changes.range_bar.step', { index: at, count })}
      </span>
      <BarButton icon={ChevronRight} label={t('changes.range_bar.next_change')} disabled={at >= count} onClick={() => stepRange(1)} />
      <span className="agent-range-bar-sep" aria-hidden />
      <ActionButton icon={Play} action="playChangedRange" onClick={playChangedRange} />
      <ActionButton icon={ChevronUp} action="seekPrevChangedRange" onClick={() => walkChangedRange(-1)} />
      <ActionButton icon={ChevronDown} action="seekNextChangedRange" onClick={() => walkChangedRange(1)} />
    </div>
  </div>
}

function BarButton({ icon, label, disabled = false, onClick }: { icon: LucideIcon; label: string; disabled?: boolean; onClick: () => void }) {
  return <button type="button" aria-label={label} title={label} aria-disabled={disabled || undefined}
    onClick={() => { if (!disabled) onClick() }}><AppIcon icon={icon} size="body" /></button>
}

/** A bar button that is also a key: named by the action, its key beside the
 *  name, as the Quick Actions strip shows it. */
function ActionButton({ icon, action, onClick }: { icon: LucideIcon; action: ActionId; onClick: () => void }) {
  const { t } = useTranslation()
  const binding = useEffectiveBindings(action)
  const name = t(ACTION_DEFS[action].labelKey)
  return <BarButton icon={icon} label={binding ? `${name} (${resolveAccelerator(binding)})` : name} onClick={onClick} />
}
