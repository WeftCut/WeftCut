import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../shared/updates'

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
