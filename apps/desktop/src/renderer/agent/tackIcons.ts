// One icon per tack mark, shared by the Tacks tab and the Review lane, so a
// chip and its panel row are recognisably the same item.
import { CircleHelp, MessageSquareText, StickyNote, TriangleAlert } from 'lucide-react'
import type { TackMark } from '../../shared/agent-activity'

export const TACK_MARK_ICON: Record<TackMark, typeof StickyNote> = {
  note: StickyNote,
  issue: TriangleAlert,
  question: CircleHelp,
  user: MessageSquareText,
}
