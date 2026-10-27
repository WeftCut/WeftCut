import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../shared/updates'
import { useSkippedUpdateVersion } from '../settings/appSettingsStore'

const OFFERED_PHASES: UpdateStatus['phase'][] = ['available', 'downloading', 'ready', 'restarting', 'error']

/** A known release past the check: something the user can download or install. */
export function isUpdateOffered(status: UpdateStatus): boolean {
  return !!status.version && OFFERED_PHASES.includes(status.phase)
}

/** Read-only polling also recovers notifications across renderer reloads. */
export function useUpdateStatus(check = false): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ phase: check ? 'checking' : 'idle' })
  useEffect(() => {
    let alive = true
    let reading = false
    const receive = (next: UpdateStatus) => { if (alive) setStatus(next) }
    const read = async (initial = false) => {
      if (reading) return
      reading = true
      try { receive(await (initial && check ? window.api.updates.check() : window.api.updates.status())) }
      catch { receive({ phase: 'error' }) }
      finally { reading = false }
    }
    void read(true)
    const timer = setInterval(() => { void read() }, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [check])
  return status
}

/** What the passive entries (start-screen icon, status-bar icon) announce: an
 *  offered update the user has not skipped. Help → Check for Updates ignores
 *  the skip, so a skipped release stays one deliberate click away. */
export function useNoticedUpdate(): UpdateStatus | null {
  const status = useUpdateStatus()
  const skipped = useSkippedUpdateVersion()
  return isUpdateOffered(status) && status.version !== skipped ? status : null
}
