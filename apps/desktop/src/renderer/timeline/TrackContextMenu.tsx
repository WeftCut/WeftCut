import { AppMenuPositioner } from "../components/PopupPositioner";
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { contextMenuFinalFocus, MenuItem, MenuSeparator } from "../menu/Menu";
import { useCursorAnchor } from "./contextMenuAnchor";
import type { TrackOrdering } from "./TrackHeader";

/// Right-click menu on a lane header. Its own component rather than an arm of
/// `LayerContextMenu` because the object being acted on is the TRACK, and its
/// state can live in the header itself: nothing here needs the cross-lane cut
/// hit-test that keeps the layer menu's state up in Timeline.
///
/// "Rename" opens the same inline edit the header's double-click does — the menu
/// exists so the gesture is discoverable without already knowing it.
export function TrackContextMenu({
  x,
  y,
  onClose,
  onRename,
  canDelete,
  onDelete,
  ordering,
}: {
  ordering?: TrackOrdering | undefined;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  canDelete: boolean;
  onDelete: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  return (
    <MenuPrimitive.Root
      open
      // Non-modal, like the layer menu: no scroll lock, and the header's own
      // scroll-close effect handles anchored-to-stale-coordinates.
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MenuPrimitive.Portal>
        <AppMenuPositioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={0}
          className="app-popup-positioner"
        >
          <MenuPrimitive.Popup
            className="app-menu-list"
            finalFocus={contextMenuFinalFocus}
          >
            <MenuItem
              label={t("timeline.rename", { defaultValue: "Rename" })}
              onSelect={onRename}
            />
            {ordering && (
              <>
                <MenuSeparator />
                {(["up", "down", "top", "bottom"] as const).map((move) => (
                  <MenuItem key={move}
                    label={t(`timeline.track_move_${move}`)}
                    disabled={ordering.disabled || (move === "up" || move === "top" ? !ordering.canMoveUp : !ordering.canMoveDown)}
                    onSelect={() => { onClose(); return ordering.onMove(move); }} />
                ))}
              </>
            )}
            {canDelete && (
              <>
                <MenuSeparator />
                <MenuItem
                  label={t("timeline.delete_track")}
                  hint={t("timeline.delete_track_hint")}
                  className="app-menu-item--destructive"
                  onSelect={onDelete}
                />
              </>
            )}
          </MenuPrimitive.Popup>
        </AppMenuPositioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
