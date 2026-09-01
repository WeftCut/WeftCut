import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { TransitionDirection } from "../ipc";
import { moveSelectionToComposition } from "../commands/groupCommands";
import {
  commandRegistryVersion,
  getCommand,
  subscribeCommandRegistry,
} from "../commands/registry";
import { groupDisplayName } from "../lib/layerName";
import { CommandContextItem } from "../menu/CommandContextItem";
import {
  closeContextMenuOn,
  contextMenuFinalFocus,
  MenuItem,
  MenuSeparator,
  SubMenu,
} from "../menu/Menu";
import { useLinkOverride } from "../state/linkOverrideStore";
import { useGroupOrdinals } from "../state/projectStore";
import { useCursorAnchor } from "./contextMenuAnchor";
import {
  addToGroupTarget,
  useAddToGroupState,
  type AddToGroupState,
} from "./groupEligibility";
import { linkFanoutActive } from "./linkEligibility";
import {
  moveDestinations,
  useMoveToCompositionState,
  type DestinationState,
  type MoveDestination,
  type MoveToCompositionState,
} from "./moveToCompositionEligibility";
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
///
/// `moveToComposition` sits in this always-present tier and NOT in the Group
/// tier below, for `groupSelected`'s reason: what it acts on is the selection,
/// whatever the selection is made of. Its most common use is a clip that is not
/// a Group at all — two ordinary clips inside one, carried back out into the
/// film — and a kind gate would put the row exactly where that selection can
/// never see it.
export const LAYER_MENU_COMMAND_IDS = [
  "copySelected",
  "pasteAtPlayhead",
  "deleteSelected",
  "---",
  "splitAtPlayhead",
  "moveToNewTrack",
  "groupSelected",
  "moveToComposition",
] as const;

/// The rows only a Group clip gets, appended when the right-clicked layer is
/// one. Registry-driven like the tier above and swept by the same test, and they
/// act on the SELECTION for the same reason the others do — a right-click selects
/// the clip first (`Timeline.tsx`'s `onContextMenu`), so "the selection" and "the
/// clip you clicked" are the same thing here.
///
/// `groupSelected` sits in the always-present tier instead, beside the other
/// structural edits: pre-composing is offered on ANY clip, which is the whole
/// point of it. `addToGroup` is here rather than there because the Group clip is
/// its DESTINATION — the row is only meaningful over the thing being added to.
///
/// Still one list even though `addToGroup` is the one row that cannot render
/// from the id alone (it names its destination and its refusal): the render
/// below branches inside the `map` rather than lifting the row out beside it,
/// so the list stays the single statement of what this tier holds and the
/// sweep in `menu/contextMenuCommands.test.ts` keeps covering every row.
export const GROUP_MENU_COMMAND_IDS = [
  "openGroup",
  "ungroupSelected",
  "addToGroup",
] as const;

/// Why a greyed *Add to Group* row is greyed, one sentence per state, in the
/// `quick_actions` namespace the strip's disabled-button reasons already live
/// in — this row is the only surface that shows them, but they are the same
/// kind of sentence and belong in the same block.
///
/// The live state is absent on purpose: the row already reads "Add to X", and a
/// tooltip restating an enabled row's own label earns nothing. A `Record` over
/// the remaining states so a new one cannot compile until someone has written
/// the instruction that tells the user what to do about it — the rule
/// `panels/quickActions.ts` states for its own two.
const ADD_TO_GROUP_REASON: Record<Exclude<AddToGroupState, "add_to_group">, string> =
  {
    needs_selection: "quick_actions.add_to_group_needs_selection",
    needs_one_group: "quick_actions.add_to_group_needs_one_group",
    needs_member: "quick_actions.add_to_group_needs_member",
    locked: "quick_actions.add_to_group_locked",
    starts_before_group: "quick_actions.add_to_group_starts_before_group",
  };

/// Why a greyed *Move to composition ›* trigger is greyed. Same block and same
/// `Record`-over-the-remaining-states rule as `ADD_TO_GROUP_REASON` above.
const MOVE_TO_COMPOSITION_REASON: Record<
  Exclude<MoveToCompositionState, "move_to_composition">,
  string
> = {
  needs_selection: "quick_actions.move_to_composition_needs_selection",
  locked: "quick_actions.move_to_composition_locked",
  no_destination: "quick_actions.move_to_composition_no_destination",
};

/// Why a greyed DESTINATION row is greyed. A separate table because these
/// explain the row rather than the gesture: the answer is which composition to
/// pick instead, not what to go and fix about the selection.
const DESTINATION_REASON: Record<Exclude<DestinationState, "eligible">, string> = {
  already_there: "quick_actions.move_to_composition_already_there",
  cycle: "quick_actions.move_to_composition_cycle",
};

/// Floating context menu (Base UI Menu) anchored to a zero-size virtual
/// element at the right-click coordinates. The popup machinery (portal,
/// outside-press + Escape close, arrow-key nav) comes from the library.
///
/// Three tiers of row, in this order:
///   1. `LAYER_MENU_COMMAND_IDS` — registry commands on the selection, which
///      carry their own labels, enabled state and accelerators.
///   2. Layer-scoped actions taking an explicit `layerId`, some of them gated
///      on the right-clicked layer's KIND — including the Group tier, which
///      mixes registry rows (`GROUP_MENU_COMMAND_IDS`) with the one
///      composition-scoped rename that has no command form.
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
/// Flat but for one row: *Move to composition ›*, whose destinations are a list
/// only the project can enumerate. Every other row is a single act, and a
/// submenu around one act is a click spent on nothing.
export function LayerContextMenu({
  x,
  y,
  layerId,
  layerKind,
  layerEnabled,
  linkId,
  linkMemberIds,
  escapeLink,
  transitionCut,
  onClose,
  onRename,
  onRenameLink,
  onRenameGroup,
  onToggleEnabled,
  onSeparateAudio,
  onPrebakeNow,
  onMarkShotCuts,
  onAddTransition,
}: {
  x: number;
  y: number;
  layerId: string;
  layerKind: string;
  layerEnabled: boolean;
  /// The right-clicked layer's link, or null — gates the link rename row.
  linkId: string | null;
  /// Every member of that link, the clicked layer included; `[layerId]` when
  /// unlinked. The Enable/Disable row's fan-out set (`docs/features.md#links`).
  linkMemberIds: readonly string[];
  /// `Alt` was held on the right-click: the same escape a left click makes,
  /// applied to the row below.
  escapeLink: boolean;
  transitionCut: TransitionCut | null;
  onClose: () => void;
  onRename: (id: string) => void;
  /// Opens the inline editor on the link's label tab (`renameStore`).
  onRenameLink: (linkId: string) => void;
  /// Opens the inline editor on the Group clip for its COMPOSITION's name.
  /// Distinct from `onRename`, which edits this clip's own label: a Group has
  /// both, and the two rows say which one they write.
  onRenameGroup: (layerId: string) => void;
  /// The set is resolved HERE and handed over whole — `set_layers_enabled`
  /// expands nothing, and one call is one undo step however many it names.
  onToggleEnabled: (layerIds: string[], enabled: boolean) => void;
  onSeparateAudio: (id: string) => void;
  onPrebakeNow: (id: string) => void;
  /// Materializes this clip's detected shot cuts as timeline markers. Layer-
  /// scoped like the two above — it takes the clicked clip's id, not the
  /// selection, because a shot report belongs to one source.
  onMarkShotCuts: (id: string) => void;
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
  // Subscribed, not read: `linkFanoutActive` reads the store itself, but a
  // menu left open across `Alt+Shift+G` has to re-label, and only a
  // subscription re-renders it.
  useLinkOverride();
  // The Enable/Disable row's targets: the link's members unless escaped — by
  // `Alt` on this right-click or by the session override — or unlinked.
  const enabledTargets =
    linkMemberIds.length > 1 && linkFanoutActive({ altKey: escapeLink })
      ? [...linkMemberIds]
      : [layerId];
  const enabledLabel =
    enabledTargets.length > 1
      ? layerEnabled
        ? t("timeline.disable_linked_layers", {
            count: enabledTargets.length,
            defaultValue: "Disable {{count}} linked layers",
          })
        : t("timeline.enable_linked_layers", {
            count: enabledTargets.length,
            defaultValue: "Enable {{count}} linked layers",
          })
      : layerEnabled
        ? t("timeline.disable_layer", { defaultValue: "Disable layer" })
        : t("timeline.enable_layer", { defaultValue: "Enable layer" });
  // The *Add to Group* row's label and tooltip. `useAddToGroupState` is the
  // subscription that keeps both live under an open popup; `addToGroupTarget`
  // reads the same two stores imperatively and is therefore re-read by the very
  // re-render that subscription causes.
  const addToGroup = useAddToGroupState();
  const groupOrdinals = useGroupOrdinals();
  const addToGroupDestination = addToGroupTarget();
  const addToGroupParams =
    addToGroupDestination?.params.kind === "CompositionRef"
      ? addToGroupDestination.params
      : null;
  // Named only when the selection names exactly one destination; the plain
  // label stands otherwise, since there is no Group to name.
  const addToGroupLabel = addToGroupParams
    ? t("actions.add_to_group_named", {
        name: groupDisplayName(
          addToGroupParams.composition_id,
          addToGroupParams.composition_label,
          groupOrdinals,
          t,
        ),
      })
    : undefined;
  const addToGroupHint =
    addToGroup === "add_to_group" ? undefined : t(ADD_TO_GROUP_REASON[addToGroup]);
  // The *Move to composition ›* trigger. Live it is a submenu — a destination
  // is the content of the gesture, and only a list can carry one — and greyed
  // it falls back to the flat registry row, which is what can show WHY. The
  // command is read from the registry so the trigger's label has the one home
  // its accelerator and its `enabled` already have, and so an unregistered
  // provider drops this row exactly as `CommandContextItem` drops the others.
  const moveToComposition = useMoveToCompositionState();
  const moveToCompositionCommand = getCommand("moveToComposition");
  const moveToCompositionHint =
    moveToComposition === "move_to_composition"
      ? undefined
      : t(MOVE_TO_COMPOSITION_REASON[moveToComposition]);
  // Resolved per right-click, never subscribed: the rows are an array, so a
  // selector over them would be a fresh reference every store tick
  // (`feedback_zustand_composite_selector`). The popup mounts on open, which is
  // what makes one read enough.
  //
  // Built for `no_destination` as well as for the live state, and that is the
  // point of the submenu: a destination refused on the cycle rule is a row
  // saying so, where a greyed trigger would leave the user guessing which
  // composition it meant. Only a selection with nothing to move — or nothing
  // movable — falls back to the flat row.
  const destinations =
    moveToComposition === "needs_selection" || moveToComposition === "locked"
      ? []
      : moveDestinations(t);
  // A live row explains itself only when the landing is not where the user
  // would guess — the destination shows nothing at this moment, so the clips go
  // to its start instead.
  const destinationHint = (d: MoveDestination): string | undefined =>
    d.state === "eligible"
      ? d.offScreen
        ? t("quick_actions.move_to_composition_offscreen")
        : undefined
      : t(DESTINATION_REASON[d.state]);
  const directionLabel = (d: TransitionDirection) =>
    t(`transitions.direction_${d}`, { defaultValue: d });
  return (
    <MenuPrimitive.Root
      open
      // Non-modal: no scroll lock — the scroll-close effect in Timeline
      // handles the anchored-to-stale-coordinates case instead.
      modal={false}
      onOpenChange={closeContextMenuOn(onClose)}
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
            finalFocus={contextMenuFinalFocus}
          >
            {LAYER_MENU_COMMAND_IDS.map((id, i) =>
              id === "---" ? (
                // Position-keyed: separators have no identity, and the list is
                // static.
                <MenuSeparator key={`sep-${i}`} />
              ) : id === "moveToComposition" ? (
                moveToCompositionCommand && destinations.length > 0 ? (
                  <SubMenu key={id} label={t(moveToCompositionCommand.labelKey)}>
                    {destinations.map((d) => {
                      const hint = destinationHint(d);
                      return (
                        <MenuItem
                          key={d.compositionId}
                          label={d.name}
                          disabled={d.state !== "eligible"}
                          {...(hint ? { hint } : {})}
                          // The landing is NOT taken from the row: it is
                          // resolved again at commit, because an open popup
                          // does not re-render while the film plays under it.
                          onSelect={() => {
                            onClose();
                            return moveSelectionToComposition(d.compositionId);
                          }}
                        />
                      );
                    })}
                  </SubMenu>
                ) : (
                  <CommandContextItem
                    key={id}
                    id={id}
                    onRun={onClose}
                    {...(moveToCompositionHint
                      ? { hint: moveToCompositionHint }
                      : {})}
                  />
                )
              ) : (
                <CommandContextItem key={id} id={id} onRun={onClose} />
              ),
            )}
            <MenuSeparator />
            <MenuItem
              label={t("timeline.rename", { defaultValue: "Rename" })}
              onSelect={() => onRename(layerId)}
            />
            {linkId !== null && (
              <MenuItem
                label={t("timeline.rename_link", { defaultValue: "Rename link…" })}
                onSelect={() => onRenameLink(linkId)}
              />
            )}
            <MenuItem
              label={enabledLabel}
              onSelect={() => onToggleEnabled(enabledTargets, !layerEnabled)}
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
            {layerKind === "CompositionRef" && (
              <>
                <MenuSeparator />
                {GROUP_MENU_COMMAND_IDS.map((id) =>
                  id === "addToGroup" ? (
                    <CommandContextItem
                      key={id}
                      id={id}
                      onRun={onClose}
                      {...(addToGroupLabel ? { label: addToGroupLabel } : {})}
                      {...(addToGroupHint ? { hint: addToGroupHint } : {})}
                    />
                  ) : (
                    <CommandContextItem key={id} id={id} onRun={onClose} />
                  ),
                )}
                <MenuItem
                  label={t("timeline.rename_group", {
                    defaultValue: "Rename group…",
                  })}
                  onSelect={() => onRenameGroup(layerId)}
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
            {layerKind === "VideoClip" && (
              <>
                <MenuSeparator />
                <MenuItem
                  label={t("timeline.mark_shot_cuts", {
                    defaultValue: "Mark shot cuts",
                  })}
                  hint={t("timeline.mark_shot_cuts_hint", {
                    defaultValue:
                      "Detect this clip's shot boundaries and drop a marker on each.",
                  })}
                  onSelect={() => onMarkShotCuts(layerId)}
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
