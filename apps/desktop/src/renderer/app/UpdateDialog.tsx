import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { AppDialog } from '../components/AppDialog'
import { Button } from '@/components/ui/button'
import { openExternal, RELEASES_URL } from './links'
import { useUpdateStatus } from './updateStatus'
import { UpdateActions } from './UpdateActions'
import { useAutoInstallUpdatesOnQuit } from '../settings/appSettingsStore'

/// Help → Check for Updates. Opening it IS the check (the same IPC the 30 s
/// startup timer fires), and it then mirrors the main-process status machine
/// once a second. Laid out like the other message-and-actions dialogs
/// (checkpoint-delete, export-experimental): settings-card body, blurb copy,
/// the shared progress track while a download runs, actions row at the foot.
export function UpdateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const statusId = useId()
  const status = useUpdateStatus(true)
  const autoInstall = useAutoInstallUpdatesOnQuit()
  const available = ['downloading', 'ready', 'restarting'].includes(status.phase)

  const percent = status.percent ?? 0
  return (
    <AppDialog title={t(available ? 'updates.available' : 'help.check_updates')} onClose={status.phase === 'restarting' ? undefined : onClose} panelClassName="settings-panel update-dialog">
      <div className="settings-body">
        <div className="settings-card">
          {/* The error copy takes the warn callout the other dialogs use for
              "read this before you continue"; every other phase is plain blurb. */}
          <p id={statusId} role="status" className={status.phase === 'error' ? 'settings-warn' : 'settings-blurb'}>
            {status.phase === 'ready'
              ? <>{t('updates.version', { version: status.version })} {t(autoInstall ? 'updates.ready_auto' : 'updates.ready_manual')}</>
              : t(`updates.${status.phase}`, { version: status.version, percent })}
          </p>
          {status.phase === 'downloading' && (
            <div
              className="progress-track"
              role="progressbar"
              aria-labelledby={statusId}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
          )}
          {available && <UpdateActions status={status} onLater={onClose} />}
          <div className="export-actions">
            <Button size="lg" onClick={() => openExternal(RELEASES_URL)}>
              {t('updates.releases')}
            </Button>
            {status.phase === 'error' && (
              <Button variant="default" size="lg" onClick={() => {
                void window.api.updates.check().catch(() => {})
              }}>{t('help.check_updates')}</Button>
            )}
          </div>
        </div>
      </div>
    </AppDialog>
  )
}
