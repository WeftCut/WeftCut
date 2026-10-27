import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { UpdateStatus } from '../../shared/updates'
import { AppDialog } from '../components/AppDialog'
import { setAppSettings, useSkippedUpdateVersion } from '../settings/appSettingsStore'

type ActionStage = 'idle' | 'downloading' | 'saving'

function useUpdateAction(needsDownload: boolean, unskip: boolean) {
  const [stage, setStage] = useState<ActionStage>('idle')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  async function run() {
    if (stage !== 'idle') return
    setStage(needsDownload ? 'downloading' : 'saving')
    setErrorKey(null)
    let failureKey = needsDownload ? 'download-failed' : 'save-failed'
    try {
      // Choosing a skipped release outright is the un-skip: main must not
      // still be holding its unattended install back.
      if (unskip) await setAppSettings({ skipped_update_version: '' })
      if (needsDownload) {
        const result = await window.api.updates.download()
        if (result !== 'ready') {
          setErrorKey(result)
          setStage('idle')
          return
        }
        // Block editing before main begins the save-and-quit handoff;
        // polling may still show downloading for up to a second.
        setStage('saving')
        failureKey = 'save-failed'
      }
      const result = await window.api.updates.restart()
      if (result !== 'restarting') {
        setErrorKey(result)
        setStage('idle')
      }
    } catch {
      setErrorKey(failureKey)
      setStage('idle')
    }
  }
  return { stage, errorKey, run }
}

function actionLabel(phase: UpdateStatus['phase'], stage: ActionStage, needsDownload: boolean) {
  if (stage === 'saving' || phase === 'restarting') return 'updates.restarting'
  if (stage === 'downloading' || phase === 'downloading') return 'updates.downloading_action'
  return needsDownload ? 'updates.download_install' : 'updates.restart'
}

/** `leading` shares the row, so a host dialog adds its secondary link without
 * stacking a second actions row under this one. */
export function UpdateActions({ status, onLater, leading }: { status: UpdateStatus; onLater: () => void; leading?: ReactNode }) {
  const { t } = useTranslation()
  const needsDownload = status.phase === 'available' || status.phase === 'error' && !!status.version
  const skipped = useSkippedUpdateVersion()
  const { stage, errorKey, run } = useUpdateAction(needsDownload, !!skipped && skipped === status.version)
  const busy = stage !== 'idle' || status.phase === 'restarting'
  return <>
    {stage === 'saving' && <AppDialog title={t('updates.restarting')} panelClassName="settings-panel update-dialog">
      <div className="settings-body"><p role="status">{t('updates.restarting')}</p></div>
    </AppDialog>}
    {errorKey && <p className="settings-error" role="alert">{t(`updates.${errorKey}`)}</p>}
    <div className="export-actions">
      {leading}
      <Button size="lg" disabled={busy} onClick={onLater}>{t('updates.later')}</Button>
      <Button variant="default" size="lg" disabled={busy || (!needsDownload && status.phase !== 'ready')} onClick={run}>
        {t(actionLabel(status.phase, stage, needsDownload))}
      </Button>
    </div>
  </>
}
