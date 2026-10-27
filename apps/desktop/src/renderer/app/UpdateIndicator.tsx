import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLineIcon } from 'lucide-react'
import { AppIcon } from '@/components/AppIcon'
import type { UpdateStatus } from '../../shared/updates'
import { useNoticedUpdate } from './updateStatus'
import { UpdateDialog } from './UpdateDialog'

function indicatorLabel(update: UpdateStatus) {
  switch (update.phase) {
    case 'downloading': return ['updates.downloading', { version: update.version, percent: update.percent ?? 0 }] as const
    case 'ready':
    case 'restarting': return ['updates.indicator_ready', { version: update.version }] as const
    case 'error': return ['updates.indicator_error', { version: update.version }] as const
    default: return ['updates.indicator_available', { version: update.version }] as const
  }
}

/// The editor's update entry: a short, fixed status-bar pill. It stays for days
/// beside transient job badges, so its text never grows with the phase; version
/// and phase live in the tooltip and accessible name, and a download draws its
/// progress as a ring around the icon. It opens the same dialog as Help → Check
/// for Updates and, like the start-screen icon, steps aside for a skipped
/// version.
export function UpdateIndicator() {
  const { t } = useTranslation()
  const update = useNoticedUpdate()
  const [open, setOpen] = useState(false)
  if (!update && !open) return null
  const label = update ? t(...indicatorLabel(update)) : ''
  return <>
    {update && (
      <button type="button" className={`status-bar-update status-bar-update-${update.phase}`}
        onClick={() => setOpen(true)} title={label} aria-label={label}>
        <span className="status-bar-update-icon">
          {update.phase === 'downloading' && (
            <svg className="status-bar-update-ring" viewBox="0 0 20 20" aria-hidden>
              <circle className="status-bar-update-track" cx="10" cy="10" r="9" />
              <circle cx="10" cy="10" r="9" pathLength={100}
                strokeDasharray={`${update.percent ?? 0} 100`} />
            </svg>
          )}
          <AppIcon icon={ArrowDownToLineIcon} size="caption" strokeWidth={2} aria-hidden />
        </span>
        {t('updates.button')}
      </button>
    )}
    {open && <UpdateDialog onClose={() => setOpen(false)} />}
  </>
}
