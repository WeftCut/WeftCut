import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ChangeClass } from '../../shared/review'
import { changeStatKey, type ChangeStat } from './changeStats'

/** The sign each class figure is shown with, as in a diff stat. */
const CLASS_SIGN: Record<ChangeClass, string> = { added: '+', removed: '−', modified: '~' }

/** How one figure reads: `short` on screen, `full` for its title and for
 *  screen readers, `tone` its colour. */
function figure(stat: ChangeStat, t: TFunction): { short: string; full: string; tone: string } {
  switch (stat.kind) {
    case 'class': return {
      short: `${CLASS_SIGN[stat.class]}${stat.count}`,
      full: t(`changes.stats.${stat.class}`, { count: stat.count }),
      tone: `class-${stat.class}${stat.count === 0 ? ' is-zero' : ''}`,
    }
  }
}

/** The Changes tab's diff stat (`changeStats.ts`), at its toolbar's start:
 *  the figures in a row, each signed and coloured like its class badge. */
export function ChangeStatsBar({ stats }: { stats: readonly ChangeStat[] }) {
  const { t } = useTranslation()
  if (!stats.length) return null
  return <p className="agent-changes-stats">
    <span className="sr-only">{t('changes.stats.label')}</span>
    {stats.map(stat => {
      const f = figure(stat, t)
      return <span key={changeStatKey(stat)} className={`agent-changes-stat ${f.tone}`} title={f.full}>
        <span aria-hidden="true">{f.short}</span><span className="sr-only">{f.full}</span>
      </span>
    })}
  </p>
}
