import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { MenuItem, MenuSeparator } from "../menu/Menu";
import { markerAnchorFor } from "./markerAtFrame";
import { useComposition } from "../state/projectStore";
import { useSelectedLayerIds } from "../state/selectionStore";
import { useCursorAnchor } from "./contextMenuAnchor";

/// Right-click menu on a marker glyph in the ruler. Its own component rather
/// than an arm of `LayerContextMenu` for the `TrackContextMenu` reason: the
/// object being acted on is the MARKER, and the ruler owns the state.
///
/// Two tiers. Rename and delete are what a marker's maintainer does to it;
/// attach and detach are the two explicit ends of anchoring (CONTEXT.md), which
/// no gesture, patch or edit may perform silently — a silently-changed anchor is
/// a marker that means something other than what the user wrote. Delete asks
/// nothing first: it is one undo away, which is the house rule for
/// destructive-but-recorded.
///
/// The anchoring rows GREY OUT rather than disappear when they do not apply. A
/// row that vanishes teaches nothing about why; a greyed one says the operation
/// exists and that this marker or this selection is not the case for it.
///
/// The rows the ruler cannot pre-compute read the stores here, as
/// `LayerContextMenu` does: the marker's own tie comes off the composition
/// summary, and the attach target off the live selection, so a menu left open
/// across a selection change re-decides instead of acting on a stale answer.
export function MarkerContextMenu({
  x,
  y,
  compositionId,
  markerId,
  onClose,
  onRename,
  onDelete,
  onAttach,
  onDetach,
}: {
  x: number;
  y: number;
  /// The composition holding this marker — the ruler's own, since a ruler
  /// paints the markers of the timeline it belongs to.
  compositionId: string | null;
  markerId: string;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  /// The attach target is resolved HERE and handed over, the way
  /// `LayerContextMenu` hands over its enable/disable set: the row is only ever
  /// offered for a target it has already checked.
  onAttach: (layerId: string) => void;
  onDetach: () => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  const composition = useComposition(compositionId);
  const selectedLayerIds = useSelectedLayerIds();
  const marker = composition?.markers.find((m) => m.id === markerId) ?? null;
  // Exactly one clip, because "attach to the selected clip" needs the selection
  // to name one — the primary of a multi-clip selection would tie the marker to
  // a clip the user cannot see the menu is talking about.
  const soleSelected =
    selectedLayerIds.size === 1 ? ([...selectedLayerIds][0] ?? null) : null;
  const attachTarget =
    composition && marker && soleSelected !== null &&
    markerAnchorFor(composition, soleSelected, marker.t_us) !== null
      ? soleSelected
      : null;
  return (
    <MenuPrimitive.Root
      open
      // Non-modal, like the track and layer menus: no scroll lock, and the
      // ruler's own scroll-close effect handles anchored-to-stale-coordinates.
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
          <MenuPrimitive.Popup className="app-menu-list">
            <MenuItem
              label={t("timeline.rename", { defaultValue: "Rename" })}
              onSelect={onRename}
            />
            <MenuItem
              label={t("timeline.delete_marker", {
                defaultValue: "Delete marker",
              })}
              onSelect={onDelete}
            />
            <MenuSeparator />
            <MenuItem
              label={t("timeline.attach_marker", {
                defaultValue: "Attach to clip",
              })}
              disabled={attachTarget === null}
              onSelect={() => {
                if (attachTarget !== null) onAttach(attachTarget);
              }}
            />
            <MenuItem
              label={t("timeline.detach_marker", { defaultValue: "Detach" })}
              disabled={marker?.anchor_layer == null}
              onSelect={onDetach}
            />
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
