// Right-click menu of a tangent handle: the owning key's continuity, Smooth or
// Broken, checkmarked at the current one. Two rows and nothing else — the
// easing menu on the key itself owns everything about the segments; this menu
// is about how the key's two sides relate to each other, which only a handle
// makes the user think about.
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { Continuity } from "../ipc";
import { MenuItem, closeContextMenuOn, contextMenuFinalFocus } from "../menu/Menu";
import { useCursorAnchor } from "./contextMenuAnchor";

const CONTINUITIES: readonly Continuity[] = ["Smooth", "Broken"];

export function ContinuityMenu({
  x, y, continuity, onPick, onClose,
}: {
  x: number;
  y: number;
  continuity: Continuity;
  onPick: (continuity: Continuity) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  return (
    <MenuPrimitive.Root open modal={false} onOpenChange={closeContextMenuOn(onClose)}>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={4}
          className="app-popup-positioner"
        >
          <MenuPrimitive.Popup
            className="app-menu-list"
            data-testid="kf-continuity-menu"
            finalFocus={contextMenuFinalFocus}
          >
            {CONTINUITIES.map((c) => (
              <MenuItem
                key={c}
                testId={`kf-continuity-${c.toLowerCase()}`}
                label={t(`keyframe.continuity_${c.toLowerCase()}`)}
                checked={continuity === c}
                onSelect={() => {
                  onPick(c);
                  onClose();
                }}
              />
            ))}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
