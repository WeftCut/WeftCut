import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownToLineIcon } from 'lucide-react'
import { AppIcon } from '@/components/AppIcon'
import { Button } from '@/components/ui/button'
import { useNoticedUpdate } from './updateStatus'
import { UpdateDialog } from './UpdateDialog'

/** A release notice; development keeps the entry visible for UI work. */
export function UpdateButton() {
  const { t } = useTranslation()
  const update = useNoticedUpdate()
  const [open, setOpen] = useState(false)
  const available = !!update
  if (!available && !import.meta.env.DEV && !open) return null
  const label = t(available ? 'updates.available' : 'help.check_updates')
  return <>
    <Button variant="default" size="icon-xs"
      className="startup-update-toggle rounded-full" onClick={() => setOpen(true)}
      title={label} aria-label={label}>
      <AppIcon icon={ArrowDownToLineIcon} size="heading" strokeWidth={1.5} aria-hidden />
    </Button>
    {open && <UpdateDialog onClose={() => setOpen(false)} />}
  </>
}
