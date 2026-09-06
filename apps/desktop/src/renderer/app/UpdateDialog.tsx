import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateStatus } from '../../shared/updates'
import { AppDialog } from '../components/AppDialog'
import { Button } from '@/components/ui/button'
import { openExternal, RELEASES_URL } from './links'

export function UpdateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'checking' })
  useEffect(() => {
    let alive = true
    const receive = (next: UpdateStatus) => { if (alive) setStatus(next) }
    const failed = () => receive({ phase: 'error' })
    void window.api.updates.check().then(receive).catch(failed)
    const timer = setInterval(() => {
      void window.api.updates.status().then(receive).catch(failed)
    }, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  return (
    <AppDialog title={t('help.check_updates')} onClose={onClose} panelClassName="settings-panel">
      <div className="settings-body">
        <p role="status">{t(`updates.${status.phase}`, {
          version: status.version, percent: status.percent ?? 0,
        })}</p>
        <div className="about-actions">
          <Button variant="secondary" onClick={() => openExternal(RELEASES_URL)}>
            {t('updates.releases')}
          </Button>
          {status.phase === 'error' && (
            <Button onClick={() => {
              setStatus({ phase: 'checking' })
              void window.api.updates.check().then(setStatus).catch(() => setStatus({ phase: 'error' }))
            }}>{t('help.check_updates')}</Button>
          )}
        </div>
      </div>
    </AppDialog>
  )
}
