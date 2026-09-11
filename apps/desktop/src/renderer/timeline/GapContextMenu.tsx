import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { contextMenuFinalFocus } from "../menu/Menu";
import { CommandContextItem } from "../menu/CommandContextItem";
import { useCursorAnchor } from "./contextMenuAnchor";
import { rippleDeleteReason, useRippleDeleteState } from "./rippleEligibility";

/// Right-click menu on a selected gap (ADR 0069). Its own component rather than
/// an arm of `LayerContextMenu` for `TrackContextMenu`'s reason: the object
/// being acted on is not a layer, and none of the layer menu's rows — rename,
/// link, group, transitions — has a meaning over empty space.
///
/// ONE row, *Ripple delete*, and no plain *Delete* beside it: a gap is already
/// empty, so deleting it can only mean closing it, and the two commands are the
/// same edit here (`App.tsx`'s `closeSelectedGap`). Premiere's gap menu offers
/// exactly this row. The row is the registry's `rippleDeleteSelected`, so it
/// greys through the same predicate the clip menu's row and the strip button
/// use, and its tooltip is the same curated refusal sentence.
export function GapContextMenu({
  x,
  y,
  onClose,
}: {
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  // Subscribed, as the clip menu's row is: a summary arriving under the open
  // popup can move a clip into the gap, and the row has to grey with it.
  const rippleDelete = useRippleDeleteState();
  const rippleDeleteHint = rippleDeleteReason(rippleDelete, t);
  return (
    <MenuPrimitive.Root
      open
      // Non-modal, like the layer menu: no scroll lock, and Timeline's own
      // scroll-close effect handles anchored-to-stale-coordinates.
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={0}
          className="app-popup-positioner"
        >
          <MenuPrimitive.Popup
            className="app-menu-list"
            data-testid="gap-context-menu"
            finalFocus={contextMenuFinalFocus}
          >
            <CommandContextItem
              id="rippleDeleteSelected"
              onRun={onClose}
              {...(rippleDeleteHint ? { hint: rippleDeleteHint } : {})}
            />
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
