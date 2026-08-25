// The Quick Actions strip's authored catalogue: which commands appear, in
// what order, under which section, with which icon, and when each reads as
// armed.
//
// These four facts live HERE rather than on `CommandDef` because they are
// presentation, not contract: `commands/registry.ts` stays pure data with no
// React/lucide dependency, and the ~60 commands that never reach a button
// don't grow optional icon/section/order fields. The behavioural half
// (`run` / `enabled` / `labelKey`) is still resolved from the registry by id,
// so a button can never drift from the command the palette and menus invoke.
//
// LANDMINE: order here is authored and load-bearing. Do NOT switch to
// iterating `listCommands()` — that walks a `Set` of providers registered at
// component mount, so its order is a by-product of mount sequence.

import {
  ArrowRightFromLine,
  ArrowRightToLine,
  Bookmark,
  BookmarkPlus,
  FoldVertical,
  Group,
  LocateFixed,
  Magnet,
  MousePointer2,
  Scissors,
  SquareDashed,
  SquareSplitHorizontal,
  Ungroup,
  UnfoldVertical,
  X,
  type LucideProps,
} from "lucide-react";
import type { ComponentType } from "react";

import type { AppSettings, DisplayMode } from "../ipc";
import type { Tool } from "../state/toolStore";
import {
  PlaybackResolutionFullIcon,
  PlaybackResolutionHalfIcon,
  PlaybackResolutionQuarterIcon,
} from "./PlaybackResolutionIcon";

/// What a strip button may draw: anything shaped like a lucide glyph. Widened
/// from `LucideIcon` itself so a hand-drawn one can sit on the same row — see
/// `PlaybackResolutionIcon.tsx`, which draws a value lucide has no glyph for.
/// Lucide's own props are the shared shape rather than a narrower invention,
/// so every stock icon stays assignable without a cast.
export type QuickActionIcon = ComponentType<LucideProps>;

/// The store-derived inputs every `active`/`hint` predicate reads. Snapshotted
/// once at the top of the panel component so the per-item predicates stay pure
/// functions — hooks can't be called per row.
export interface QuickActionState {
  tool: Tool;
  displayMode: DisplayMode;
  /// Whether any in/out point is marked (`rangeStore.ts`). Not a position —
  /// the strip can't render one, and subscribing to the positions would
  /// re-render the whole strip on every handle drag.
  hasRange: boolean;
  /// Whether the timeline ruler paints markers (app-level pref). The strip's
  /// whole marker state: it never reports whether the project HAS any markers,
  /// so the strip takes no project-store subscription and the hint stays
  /// two-state.
  markersVisible: boolean;
  /// Clip snapping — the magnet (`tail_snap_enabled`).
  snapEnabled: boolean;
  /// Whether the timeline pages itself to keep the playhead on screen.
  followPlayhead: boolean;
  /// Whether the preview draws the title-safe / action-safe rectangles.
  safeAreaGuides: boolean;
  /// Preview decode resolution. The `resolution` section's one button draws
  /// it and names it in the tooltip — with no pressed state to fall back on,
  /// this field IS what the button reports. The preview itself subscribes to
  /// the store directly.
  playbackResolution: AppSettings["playback_resolution"];
  /// Whether ≥2 layers are selected (`useCanGroupSelection`). A boolean
  /// selector for the `hasRange` reason: the strip re-renders when the answer
  /// flips, not on every click-select.
  canGroup: boolean;
  /// Whether the selection touches a group (`useCanDissolveSelection`).
  canDissolve: boolean;
}

export interface QuickActionItem {
  /// Command id in `commands/registry.ts`. Resolved through `getCommand` for
  /// `run` / `enabled` / `labelKey`.
  id: string;
  /// The button's glyph. Static for everything whose meaning doesn't move.
  icon: QuickActionIcon;
  /// State-bearing glyph, for buttons where the icon itself depicts the
  /// current state rather than a fixed concept. Overrides `icon` when present,
  /// the same way `hint` overrides the command's `labelKey`.
  iconFor?: (state: QuickActionState) => QuickActionIcon;
  /// Whether the button renders pressed. For a radio section exactly one item
  /// should be true; for an independent section each item answers for itself.
  /// Omitted by `command` items, which have no pressed state at all.
  active?: (state: QuickActionState) => boolean;
  /// State-bearing tooltip / aria-label key, for buttons whose meaning depends
  /// on the current value ("showing X, click for Y"). Omit to use the
  /// command's own `labelKey`.
  hint?: (state: QuickActionState) => string;
}

export interface QuickActionSection {
  id: string;
  /// How the section's buttons report state to assistive tech, which is the
  /// whole reason the split exists:
  /// - `radio` = modal, mutually exclusive (the exclusivity comes from the
  ///   underlying state, not from this panel) → `aria-checked` in a radiogroup.
  /// - `independent` = each button answers only for itself → `aria-pressed`.
  /// - `command` = momentary; fires and forgets → NEITHER attribute.
  ///
  /// `command` is not cosmetic. A one-shot action carrying `aria-pressed=false`
  /// is narrated as an off switch, which promises a state it does not have —
  /// so these items also omit `active` rather than hard-coding it false.
  mode: "radio" | "independent" | "command";
  items: QuickActionItem[];
}

export const QUICK_ACTION_SECTIONS: readonly QuickActionSection[] = [
  {
    id: "tools",
    mode: "radio",
    items: [
      {
        id: "selectTool",
        icon: MousePointer2,
        active: (s) => s.tool === "select",
      },
      {
        // Historical id — it selects the Blade, it no longer toggles.
        id: "toggleBladeMode",
        icon: Scissors,
        active: (s) => s.tool === "blade",
      },
    ],
  },
  {
    id: "toggles",
    mode: "independent",
    items: [
      {
        id: "toggleDisplayMode",
        // Fallback only; `iconFor` answers on every real render. Matches the
        // `AbRoll` default in `appSettingsStore.ts`'s FALLBACK settings.
        icon: FoldVertical,
        // The glyph depicts the CURRENT state, not the click's effect, so it
        // agrees with `aria-pressed` instead of contradicting it: folded rows
        // = pressed = fold arrows. The "click to X" half is the hint's job.
        iconFor: (s) => (s.displayMode === "AbRoll" ? FoldVertical : UnfoldVertical),
        // Pressed = filtered down to the A/B-roll rows.
        active: (s) => s.displayMode === "AbRoll",
        // The hint separates state from action: "showing X, click for Y".
        hint: (s) =>
          s.displayMode === "AbRoll"
            ? "timeline.mode_ab_roll_hint"
            : "timeline.mode_all_tracks_hint",
      },
      {
        id: "toggleMarkersVisible",
        // One fixed glyph, unlike the display toggle above: that button switches
        // between two MODES whose glyphs depict which one is current, whereas
        // this is a plain on/off switch whose state the pressed styling and
        // `aria-pressed` already carry. A crossed-out bookmark would restate at
        // 16 px what the button already says.
        icon: Bookmark,
        // Pressed = the marker layer is painting.
        active: (s) => s.markersVisible,
        // Two states, so two keys — same "showing X, click for Y" split as the
        // display toggle's pair.
        hint: (s) =>
          s.markersVisible
            ? "quick_actions.markers_shown_hint"
            : "quick_actions.markers_hidden_hint",
      },
      {
        // The magnet. Its home in every NLE is a toolbar button, and until this
        // row it lived only in Settings — a per-edit switch behind a
        // preferences panel. One fixed glyph for the marker-toggle reason: a
        // plain on/off whose state the pressed styling already carries.
        id: "toggleTailSnap",
        icon: Magnet,
        active: (s) => s.snapEnabled,
        hint: (s) =>
          s.snapEnabled
            ? "quick_actions.snap_on_hint"
            : "quick_actions.snap_off_hint",
      },
      {
        // Auto-scroll. `LocateFixed` rather than an arrow: the button is about
        // keeping a target centred, not about a direction of travel.
        id: "toggleFollowPlayhead",
        icon: LocateFixed,
        active: (s) => s.followPlayhead,
        hint: (s) =>
          s.followPlayhead
            ? "quick_actions.follow_on_hint"
            : "quick_actions.follow_off_hint",
      },
      {
        // Title-safe / action-safe rectangles. It has NO keyboard binding at
        // all, so before this row the only way to reach it was the search
        // palette — the strip is its one-click home.
        id: "toggleSafeAreaGuides",
        icon: SquareDashed,
        active: (s) => s.safeAreaGuides,
        hint: (s) =>
          s.safeAreaGuides
            ? "quick_actions.safe_area_on_hint"
            : "quick_actions.safe_area_off_hint",
      },
    ],
  },
  {
    // Edits that need no pointer. The Blade above can only cut where the mouse
    // is; `splitAtPlayhead` cuts on the line, which is how the same operation
    // is reached from the keyboard and from here.
    id: "edit",
    mode: "command",
    items: [
      {
        // No `hint`, and deliberately no disabled state: whether a clip
        // straddles the playhead changes as the playhead MOVES, and gating on
        // it would mean subscribing the strip to the playhead — one re-render
        // per frame, which the playhead gate forbids. The command no-ops over
        // a gap, exactly as `Ctrl+K` does in Premiere.
        id: "splitAtPlayhead",
        icon: SquareSplitHorizontal,
      },
      {
        id: "groupSelected",
        icon: Group,
        // Same disabled-button rule as `clearRange`: with too small a
        // selection the hint names the precondition instead of restating a
        // label that cannot be used.
        hint: (s) =>
          s.canGroup ? "actions.group_selected" : "quick_actions.group_needs_two",
      },
      {
        id: "dissolveSelectedGroup",
        icon: Ungroup,
        hint: (s) =>
          s.canDissolve
            ? "actions.dissolve_selected_group"
            : "quick_actions.dissolve_no_group",
      },
    ],
  },
  {
    // In/out marking. The strip is where this feature becomes discoverable at
    // all: the buttons carry their `I` / `O` accelerator in the tooltip, so the
    // one-click path teaches the keyboard path. It cannot show WHERE the points
    // are — that is the ruler's job — but the clear button's enabled state is a
    // standing, zero-cost signal that a range exists at all.
    id: "range",
    mode: "command",
    items: [
      // Direction carries the meaning: content STARTS at this line (arrow
      // leaving it) vs. content ENDS at it (arrow arriving).
      { id: "markIn", icon: ArrowRightFromLine },
      { id: "markOut", icon: ArrowRightToLine },
      {
        id: "clearRange",
        icon: X,
        // The command is disabled with no range marked, and a disabled button
        // with an unchanged tooltip reads as broken — so the hint explains the
        // reason instead of restating the label.
        hint: (s) =>
          s.hasRange ? "actions.clear_range" : "quick_actions.clear_range_empty",
      },
    ],
  },
  {
    // Marker AUTHORING, separate from the marker toggle up in `toggles` — the
    // two are the same feature but not the same kind of control, and the ARIA
    // mode is what splits them: adding a marker is momentary, showing them is
    // a switch. Before this row the strip could hide markers it had no way to
    // create.
    id: "markers",
    mode: "command",
    items: [{ id: "addMarkerAtPlayhead", icon: BookmarkPlus }],
  },
  {
    // Preview decode resolution — ONE button walking three rungs, where the
    // section used to spend three slots stating one value.
    //
    // `command`, not `radio`, and the mode is the substance of the change: a
    // radiogroup of one button cannot say anything ("exactly one of one is
    // chosen" is not information), and `aria-pressed` on a three-state control
    // would announce a switch that has no off. Momentary is what a cycling
    // button honestly is, so the whole current value rides on the glyph and
    // the hint — which is also why `active` is absent and the button never
    // renders pressed.
    //
    // That is only honest because the glyph SAYS the value. This section was
    // three buttons for as long as its icons were a signal ladder that could
    // draw "less" but not "half"; `PlaybackResolutionIcon` fills that
    // fraction of a frame, so a single button can be read at rest and the
    // cycle has a direction from every rung.
    id: "resolution",
    mode: "command",
    items: [
      {
        id: "cyclePlaybackResolution",
        // Fallback only; `iconFor` answers on every real render. Matches the
        // `full` default in `appSettingsStore.ts`'s FALLBACK settings.
        icon: PlaybackResolutionFullIcon,
        iconFor: (s) => RESOLUTION_ICONS[s.playbackResolution],
        hint: (s) => RESOLUTION_HINTS[s.playbackResolution],
      },
    ],
  },
];

/// Glyph per rung. Total `Record`s rather than lookups with a fallback: a
/// fourth playback resolution must not compile until someone has decided what
/// it looks like and what its tooltip promises, because the only fallback
/// available here — draw the previous rung — would be a lie about the value
/// the preview is actually shipping.
const RESOLUTION_ICONS: Record<
  AppSettings["playback_resolution"],
  QuickActionIcon
> = {
  full: PlaybackResolutionFullIcon,
  half: PlaybackResolutionHalfIcon,
  quarter: PlaybackResolutionQuarterIcon,
};

/// Tooltip per rung, keyed on the CURRENT value. Each string names the value
/// the button is on and the one a click moves to, so the successor order in
/// `PLAYBACK_RESOLUTION_CYCLE` is restated in prose here — the pair that can
/// drift, and the reason `quickActions.test.ts` asserts one key per rung and
/// no two rungs sharing one.
const RESOLUTION_HINTS: Record<AppSettings["playback_resolution"], string> = {
  full: "quick_actions.resolution_full_hint",
  half: "quick_actions.resolution_half_hint",
  quarter: "quick_actions.resolution_quarter_hint",
};

/// The glyph to draw for `item` right now. Called per render, so a
/// state-bearing icon can never be cached into a stale component.
export function resolveIcon(
  item: QuickActionItem,
  state: QuickActionState,
): QuickActionIcon {
  return item.iconFor?.(state) ?? item.icon;
}

/// Flat id list — used by the alignment test and by anything that needs to
/// know whether a command has a strip button.
export const QUICK_ACTION_IDS: readonly string[] = QUICK_ACTION_SECTIONS.flatMap(
  (section) => section.items.map((item) => item.id),
);
