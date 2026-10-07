import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { UpdateStatus } from '../../shared/updates'
import { AppDialog } from '../components/AppDialog'

export function UpdateActions({ status, onLater }: { status: UpdateStatus; onLater: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const restarting = busy || status.phase === 'restarting'
  return <>
    {busy && <AppDialog title={t('updates.restarting')} panelClassName="settings-panel update-dialog">
      <div className="settings-body"><p role="status">{t('updates.restarting')}</p></div>
    </AppDialog>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="export-actions">
      <Button variant="default" size="lg" disabled={restarting || status.phase !== 'ready'} onClick={async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          const result = await window.api.updates.restart()
          if (result !== 'restarting') {
            setError(t(`updates.${result}`))
            setBusy(false)
          }
        } catch {
          setError(t('updates.save-failed'))
          setBusy(false)
        }
      }}>{t(restarting ? 'updates.restarting' : 'updates.restart')}</Button>
      <Button size="lg" disabled={restarting} onClick={onLater}>{t('updates.later')}</Button>
    </div>
  </>
}
