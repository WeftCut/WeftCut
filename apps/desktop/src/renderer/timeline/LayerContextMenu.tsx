import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { TransitionDirection } from "../ipc";
import {
  commandRegistryVersion,
  subscribeCommandRegistry,
} from "../commands/registry";
import { CommandContextItem } from "../menu/CommandContextItem";
import { MenuItem, MenuSeparator } from "../menu/Menu";
import { useCursorAnchor } from "./contextMenuAnchor";
import {
  TRANSITION_DIRECTIONS,
  type TransitionCut,
  type TransitionKindName,
} from "./transitions";

/// The clip menu's registry-driven rows, in order, with `"---"` for the
/// separators. Exported for the test that sweeps them against the command
/// catalogue — the safety net `CommandContextItem`'s untyped `id` trades away.
///
/// Two families. The clipboard trio first, because that is where every editor's
/// eye goes on a right-click and where these operations sit in Premiere and
/// Resolve alike. Then the two structural edits: cut this clip in half, or lift
/// it onto a lane of its own.
///
/// All five act on the SELECTION, which is exactly why right-clicking a clip
/// now selects it (`Timeline.tsx`'s `onContextMenu`) — the rows would otherwise
/// be able to act on a clip other than the one under the cursor.
///
/// `splitAtPlayhead` and not a cursor-anchored "split here": splitting where
/// you pointed is the Blade tool's whole job, and it is one key (`C`) and one
/// strip button away. Resolve makes the same split — its clip menu's "Split
/// Clip" cuts at the playhead too.
export const LAYER_MENU_COMMAND_IDS = [
  "copySelected",
  "pasteAtPlayhead",
  "deleteSelected",
  "---",
  "splitAtPlayhead",
  "moveToNewTrack",
] as const;

/// Floating context menu (Base UI Menu) anchored to a zero-size virtual
/// element at the right-click coordinates. The popup machinery (portal,
/// outside-press + Escape close, arrow-key nav) comes from the library.
///
/// Three tiers of row, in this order:
///   1. `LAYER_MENU_COMMAND_IDS` — registry commands on the selection, which
///      carry their own labels, enabled state and accelerators.
///   2. Layer-scoped actions taking an explicit `layerId`, some of them gated
///      on the right-clicked layer's KIND.
///   3. The transition section, appended only when the right-click landed
///      within the click-tolerance band of a cut between same-track adjacent
///      visual layers (`transitionCut` non-null).
///
/// Every row goes through `Menu.tsx`'s `MenuItem`, tiers 2 and 3 included.
/// A bare `MenuPrimitive.Item` with a text child renders without the 16px
/// check-glyph gutter `MenuItem` puts before its label, so tier 1 (which
/// reaches `MenuItem` via `CommandContextItem`) and the tiers under it used
/// to sit on two different left edges inside the one popup.
///
/// Flat, like every menu here except the transition chip's — no submenus.
export function LayerContextMenu({
  x,
  y,
  layerId,
  layerKind,
  layerEnabled,
  transitionCut,
  onClose,
  onRename,
  onToggleEnabled,
  onSeparateAudio,
  onPrebakeNow,
  onAddTransition,
}: {
  x: number;
  y: number;
  layerId: string;
  layerKind: string;
  layerEnabled: boolean;
  transitionCut: TransitionCut | null;
  onClose: () => void;
  onRename: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onSeparateAudio: (id: string) => void;
  onPrebakeNow: (id: string) => void;
  onAddTransition: (
    cut: TransitionCut,
    kind: TransitionKindName,
    direction?: TransitionDirection,
  ) => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  // Providers register in post-paint effects, long before any right-click. The
  // subscription is here so the rows survive a provider remounting under an
  // already-open menu, and costs one line.
  useSyncExternalStore(subscribeCommandRegistry, commandRegistryVersion);
  const directionLabel = (d: TransitionDirection) =>
    t(`transitions.direction_${d}`, { defaultValue: d });
  return (
    <MenuPrimitive.Root
      open
      // Non-modal: no scroll lock — the scroll-close effect in Timeline
      // handles the anchored-to-stale-coordinates case instead.
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
            {LAYER_MENU_COMMAND_IDS.map((id, i) =>
              id === "---" ? (
                // Position-keyed: separators have no identity, and the list is
                // static.
                <MenuSeparator key={`sep-${i}`} />
              ) : (
                <CommandContextItem key={id} id={id} onRun={onClose} />
              ),
            )}
            <MenuSeparator />
            <MenuItem
              label={t("timeline.rename", { defaultValue: "Rename" })}
              onSelect={() => onRename(layerId)}
            />
            <MenuItem
              label={
                layerEnabled
                  ? t("timeline.disable_layer", {
                      defaultValue: "Disable layer",
                    })
                  : t("timeline.enable_layer", { defaultValue: "Enable layer" })
              }
              onSelect={() => onToggleEnabled(layerId, !layerEnabled)}
            />
            {layerKind === "Audio" && (
              <>
                <MenuSeparator />
                <MenuItem
                  label={t("timeline.separate_audio", {
                    defaultValue: "Separate audio to new track",
                  })}
                  onSelect={() => onSeparateAudio(layerId)}
                />
              </>
            )}
            {layerKind === "Motif" && (
              <>
                <MenuSeparator />
                <MenuItem
                  label={t("timeline.prebake_now", {
                    defaultValue: "Pre-bake now",
                  })}
                  onSelect={() => onPrebakeNow(layerId)}
                />
              </>
            )}
            {transitionCut && (
              <>
                <MenuSeparator />
                <MenuItem
                  label={t("timeline.add_transition_crossfade", {
                    defaultValue: "Add crossfade",
                  })}
                  onSelect={() => onAddTransition(transitionCut, "Crossfade")}
                />
                {TRANSITION_DIRECTIONS.map((d) => (
                  <MenuItem
                    key={`wipe-${d}`}
                    label={t("timeline.add_transition_wipe", {
                      direction: directionLabel(d),
                      defaultValue: "Add wipe · {{direction}}",
                    })}
                    onSelect={() => onAddTransition(transitionCut, "Wipe", d)}
                  />
                ))}
                {TRANSITION_DIRECTIONS.map((d) => (
                  <MenuItem
                    key={`slide-${d}`}
                    label={t("timeline.add_transition_slide", {
                      direction: directionLabel(d),
                      defaultValue: "Add slide · {{direction}}",
                    })}
                    onSelect={() => onAddTransition(transitionCut, "Slide", d)}
                  />
                ))}
              </>
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
