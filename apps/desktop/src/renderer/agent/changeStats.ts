// The figures of the Changes tab's diff stat (ADR 0115): what the unreviewed
// list amounts to, read at a glance the way a git diff stat is. Pure — the stat is
// drawn by `ChangeStatsBar.tsx`, the list comes from `reviewStore.ts`.
//
// A figure is a fact, never a sentence: `changeStats` decides which figures
// there are and their values, the component words and colours each `kind`.
// Adding one is a variant of `ChangeStat`, the input it needs on
// `ChangeStatsInput`, a line in `changeStats`, and a case in the component's
// switch (which fails to compile until it has one).
import type { Change, ChangeClass, ChangedRange } from '../../shared/review'

/** What the figures are read from. */
export interface ChangeStatsInput {
  unreviewed: readonly Change[]
  /** The changed ranges to review (ADR 0169), of every composition. */
  ranges?: readonly ChangedRange[]
  /** The root composition: the film, whose ranges the figure counts. */
  filmId?: string | null
}

/** One figure of the diff stat. */
export type ChangeStat =
  /** How many unreviewed changes are of `class` — entities, not time. */
  | { kind: 'class'; class: ChangeClass; count: number }
  /** How many stretches of the film play differently, and how long they run
   *  now — what there is to watch again. A cut point counts and adds no time. */
  | { kind: 'ranges'; count: number; durationUs: number }

/** The class figures in diff-stat order: `+` added, `−` removed, `~` modified. */
const CLASS_ORDER: readonly ChangeClass[] = ['added', 'removed', 'modified']

/** The diff stat's figures, in display order. Each class figure is present
 *  even at zero, so the stat keeps one shape while the list changes; the
 *  range figure follows them only while there are ranges to review. */
export function changeStats(input: ChangeStatsInput): ChangeStat[] {
  const counts = new Map<ChangeClass, number>(CLASS_ORDER.map(c => [c, 0]))
  for (const c of input.unreviewed) counts.set(c.class, (counts.get(c.class) ?? 0) + 1)
  const out: ChangeStat[] = CLASS_ORDER.map(cls => ({ kind: 'class', class: cls, count: counts.get(cls) ?? 0 }))
  // The film's ranges only: the root already holds what each Group shows of
  // its composition, so a Group's own ranges would count that stretch twice.
  const ranges = (input.ranges ?? []).filter(r => r.source === 'review' && r.composition_id === input.filmId)
  if (ranges.length > 0) out.push({ kind: 'ranges', count: ranges.length, durationUs: ranges.reduce((sum, r) => sum + Math.max(0, r.t_end_us - r.t_start_us), 0) })
  return out
}

/** A key unique among one stat's figures. */
export function changeStatKey(stat: ChangeStat): string {
  switch (stat.kind) {
    case 'class': return `class:${stat.class}`
    case 'ranges': return 'ranges'
  }
}
