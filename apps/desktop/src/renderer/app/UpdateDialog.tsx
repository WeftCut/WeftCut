import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { AppDialog } from '../components/AppDialog'
import { Button } from '@/components/ui/button'
import { openExternal, RELEASES_URL } from './links'
import { isUpdateOffered, useUpdateStatus } from './updateStatus'
import { UpdateActions } from './UpdateActions'
import { setAppSettings, useAutoInstallUpdatesOnQuit } from '../settings/appSettingsStore'

/// Help → Check for Updates. Opening it IS the check (the same IPC the 5 s
/// startup timer fires), and it then mirrors the main-process status machine
/// once a second. Laid out like the other message-and-actions dialogs
/// (checkpoint-delete, export-experimental): settings-card body, blurb copy,
/// the shared progress track while a download runs, one actions row at the foot.
export function UpdateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const statusId = useId()
  const status = useUpdateStatus(true)
  const autoInstall = useAutoInstallUpdatesOnQuit()
  const available = isUpdateOffered(status)

  const percent = status.percent ?? 0
  // Alone in the row it is the dialog's only action; beside others it steps back.
  const besideOthers = available || status.phase === 'error'
  const releases = (
    <Button variant={besideOthers ? 'ghost' : 'secondary'} size="lg"
      className={besideOthers ? 'mr-auto' : undefined}
      onClick={() => openExternal(RELEASES_URL)}>
      {t('updates.releases')}
    </Button>
  )
  // Skipping silences the passive entries and main's unattended download for
  // this version only. An error keeps the releases link its copy points to.
  const skip = (
    <Button variant="ghost" size="lg" className="mr-auto" disabled={status.phase === 'restarting'}
      onClick={() => {
        void setAppSettings({ skipped_update_version: status.version }).catch(error => console.warn('[updates] skip', error))
        onClose()
      }}>
      {t('updates.skip')}
    </Button>
  )
  return (
    <AppDialog title={t(available ? 'updates.available' : 'updates.title')} onClose={status.phase === 'restarting' ? undefined : onClose} panelClassName="settings-panel update-dialog">
      <div className="settings-body">
        <div className="settings-card">
          {/* The error copy takes the warn callout the other dialogs use for
              "read this before you continue"; every other phase is plain blurb. */}
          <p id={statusId} role="status" className={status.phase === 'error' ? 'settings-warn' : 'settings-blurb'}>
            {status.phase === 'ready'
              ? <>{t('updates.version', { version: status.version })} {t(autoInstall ? 'updates.ready_auto' : 'updates.ready_manual')}</>
              : t(status.phase === 'available' ? 'updates.available_manual' : `updates.${status.phase}`, { version: status.version, percent })}
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
          {/* One footer row: the quiet way out (skip, or the releases page)
              pinned left; the update itself (or a retry check) owns the right.
              A known version's error retries through the download button. */}
          {available
            ? <UpdateActions status={status} onLater={onClose} leading={status.phase === 'error' ? releases : skip} />
            : <div className="export-actions">
              {releases}
              {status.phase === 'error' && (
                <Button variant="default" size="lg" onClick={() => {
                  void window.api.updates.check().catch(() => {})
                }}>{t('help.check_updates')}</Button>
              )}
            </div>}
        </div>
      </div>
    </AppDialog>
  )
}
