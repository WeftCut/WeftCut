import { useTranslation } from 'react-i18next'
import { Crosshair } from 'lucide-react'
import { AppIcon } from '@/components/AppIcon'
import { useCompositionAnchorStore } from '../state/compositionAnchorStore'
import { useProjectStore } from '../state/projectStore'
import { canJump, jump, type LocateItem } from './locate'

/** The agent view's Jump: moves the preview to a review item's
 *  time and nothing else — the editor's Locate selects and navigates. Offered
 *  while the item sits on the composition the preview shows; `why` names a
 *  reason it has no place at all. */
export function JumpButton({ item, why = null, onJump }: { item: LocateItem; why?: string | null; onJump?: () => void }) {
  const { t } = useTranslation()
  // Read so a row re-renders when the composition shown or the project moves.
  useCompositionAnchorStore(s => s.focusedId)
  useProjectStore(s => s.summary)
  const can = canJump(item)
  const title = can ? t('agent_panel.jump') : why ?? t('agent_panel.jump_elsewhere')
  return <button type="button" aria-label={t('agent_panel.jump')} title={title} disabled={!can}
    onClick={() => { onJump?.(); jump(item) }}><AppIcon icon={Crosshair} size="body" /></button>
}
