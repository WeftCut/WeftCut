// The figures of the Changes tab's diff stat (ADR 0115): what the unreviewed
// list amounts to, read at a glance the way a git diff stat is. Pure — the stat is
// drawn by `ChangeStatsBar.tsx`, the list comes from `reviewStore.ts`.
//
// A figure is a fact, never a sentence: `changeStats` decides which figures
// there are and their values, the component words and colours each `kind`.
// Adding one is a variant of `ChangeStat`, the input it needs on
// `ChangeStatsInput`, a line in `changeStats`, and a case in the component's
// switch (which fails to compile until it has one).
//
// Every figure counts entities, like the list below it. How many stretches of
// the film play differently, and how long, is the range bar's (`RangeBar.tsx`).
import type { Change, ChangeClass } from '../../shared/review'

/** What the figures are read from. */
export interface ChangeStatsInput {
  unreviewed: readonly Change[]
}

/** One figure of the diff stat. */
export type ChangeStat =
  /** How many unreviewed changes are of `class`. */
  | { kind: 'class'; class: ChangeClass; count: number }

/** The class figures in diff-stat order: `+` added, `−` removed, `~` modified. */
const CLASS_ORDER: readonly ChangeClass[] = ['added', 'removed', 'modified']

/** The diff stat's figures, in display order. Each class figure is present
 *  even at zero, so the stat keeps one shape while the list changes. */
export function changeStats(input: ChangeStatsInput): ChangeStat[] {
  const counts = new Map<ChangeClass, number>(CLASS_ORDER.map(c => [c, 0]))
  for (const c of input.unreviewed) counts.set(c.class, (counts.get(c.class) ?? 0) + 1)
  return CLASS_ORDER.map(cls => ({ kind: 'class', class: cls, count: counts.get(cls) ?? 0 }))
}

/** A key unique among one stat's figures. */
export function changeStatKey(stat: ChangeStat): string {
  switch (stat.kind) {
    case 'class': return `class:${stat.class}`
  }
}
