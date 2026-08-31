import { useSyncExternalStore } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

import {
  commandRegistryVersion,
  subscribeCommandRegistry,
} from "../commands/registry";
import { CommandContextItem } from "../menu/CommandContextItem";
import { MenuSeparator } from "../menu/Menu";
import { useCursorAnchor } from "./contextMenuAnchor";

/// The menu's rows, in order. Exported so a test can sweep them against the
/// command registry — the safety net `CommandContextItem`'s untyped `id`
/// trades away (see its docstring).
///
/// Two families, separated: the in/out range, then the markers. Both are
/// playhead operations, which is why they share a menu at all; they are
/// different objects, which is why they don't share a section.
///
/// The marker section runs author, walk, then display — the walk rows sit with
/// the marks they move between rather than with the seeks, because this menu is
/// where an editor discovers that markers can be walked at all, and the
/// accelerator beside each row is what turns that into a keystroke.
export const RULER_MENU_COMMAND_IDS = [
  "markIn",
  "markOut",
  "clearRange",
  "---",
  "addMarkerAtPlayhead",
  "seekPrevMarker",
  "seekNextMarker",
  "toggleMarkersVisible",
] as const;

/**
 * Right-click menu on the time ruler — the in/out and marker family, which
 * until now existed only on the keyboard, in the Quick Actions strip and in the
 * search palette. Right-clicking the ruler is where an editor coming from
 * Premiere or Resolve looks for it first.
 *
 * Every row is a registry command, so this file carries no handlers, no
 * labels, and no state: `CommandContextItem` resolves each id to the same
 * `run` / `enabled` / `labelKey` the key and the strip button use, and renders
 * the accelerator beside it — which is what turns the discovered menu row into
 * a learned keystroke.
 *
 * PLAYHEAD, NOT CURSOR. Every row acts at the playhead, not at the x the user
 * right-clicked. That is the commands' own contract (`markIn` reads
 * `playheadTimeUs`), it matches Premiere's ruler menu, and it is the honest
 * reading of these operations: an in point is a property of where you ARE, not
 * of where you pointed. Nothing on this strip is spatial, which is what lets one
 * menu cover the whole of it: the spatial objects have their own cursor-anchored
 * menus elsewhere — a marker in the lane below (`MarkerContextMenu`), a cut on a
 * track lane (the layer menu's transition section). Do not "fix" this by seeking
 * to the click first: a right-click that moves the playhead is a worse surprise
 * than one that doesn't.
 */
export function RulerContextMenu({
  x,
  y,
  onClose,
}: {
  x: number;
  y: number;
  onClose: () => void;
}) {
  const anchor = useCursorAnchor(x, y);
  // The registry mounts its providers in post-paint effects. This menu only
  // ever opens long after that, but the subscription costs one line and keeps
  // the rows from vanishing if a provider ever remounts under an open menu.
  useSyncExternalStore(subscribeCommandRegistry, commandRegistryVersion);
  return (
    <MenuPrimitive.Root
      open
      // Non-modal, like every other context menu here: no scroll lock, and the
      // ruler's own scroll-close effect handles stale cursor coordinates.
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
            {RULER_MENU_COMMAND_IDS.map((id, i) =>
              id === "---" ? (
                // Position-keyed: separators have no identity, and the list is
                // static.
                <MenuSeparator key={`sep-${i}`} />
              ) : (
                <CommandContextItem key={id} id={id} onRun={onClose} />
              ),
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
