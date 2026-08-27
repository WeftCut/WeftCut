import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import { MenuItem, MenuSeparator } from "../menu/Menu";
import { useCursorAnchor } from "../timeline/contextMenuAnchor";
import type { RestackMenuTargets, RestackTarget } from "./playheadItems";

/// Right-click menu on a Playhead Panel row. Two item groups, each present
/// only where it applies, so no row ever gets an empty menu:
///
/// - Ordering (`targets`), on At-playhead visual rows — the non-drag path to
///   the same restack op as the grip (ADR 0044 decision 4: every drag has a
///   keyboard-reachable equivalent). The caller resolves each item to its
///   anchored restack (or null = disabled) via `restackMenuTargets` at open
///   time, so this component is purely presentational and the op surface
///   stays above/below.
/// - Link (`link`), on a folded link row wherever it sits: rename the link's
///   label, or dissolve the link.
///
/// Same virtual-anchor Base UI menu as the timeline's and the media pool's:
/// placement from the right-click coordinates, outside-press + Escape close
/// and arrow-key navigation from the library.
export function PlayheadRowContextMenu({
  x,
  y,
  label,
  targets,
  link,
  onClose,
  onAction,
  onRenameLink,
  onUnlink,
}: {
  x: number;
  y: number;
  /// The row's display name, for the popup's accessible name.
  label: string;
  /// Null when the row is not in the visible visual stack.
  targets: RestackMenuTargets | null;
  /// The link a folded row stands for; null on a plain layer row.
  link: { id: string; label: string | null } | null;
  onClose: () => void;
  /// Fires exactly once per chosen item with the item's anchored restack.
  onAction: (target: RestackTarget) => void;
  onRenameLink: (linkId: string) => void;
  onUnlink: (linkId: string) => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  const item = (target: RestackTarget | null, text: string) => (
    <MenuItem
      label={text}
      disabled={target === null}
      onSelect={() => {
        if (target) onAction(target);
      }}
    />
  );
  return (
    <MenuPrimitive.Root
      open
      // Non-modal, like every context menu here: no scroll lock — the
      // panel's scroll-close effect handles anchored-to-stale-coordinates.
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
            aria-label={t(
              targets ? "playhead_panel.row_menu" : "playhead_panel.link_menu",
              { label },
            )}
          >
            {targets && (
              <>
                {item(targets.bringForward, t("playhead_panel.restack_forward"))}
                {item(targets.sendBackward, t("playhead_panel.restack_backward"))}
                {item(targets.bringToFront, t("playhead_panel.restack_front"))}
                {item(targets.sendToBack, t("playhead_panel.restack_back"))}
              </>
            )}
            {targets && link && <MenuSeparator />}
            {link && (
              <>
                <MenuItem
                  label={t("playhead_panel.rename_link")}
                  onSelect={() => onRenameLink(link.id)}
                />
                <MenuItem
                  label={t("playhead_panel.unlink")}
                  onSelect={() => onUnlink(link.id)}
                />
              </>
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
