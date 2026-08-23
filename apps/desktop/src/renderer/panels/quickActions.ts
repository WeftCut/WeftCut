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
  Blend,
  Bookmark,
  BookmarkPlus,
  FoldVertical,
  Group,
  LocateFixed,
  Magnet,
  MousePointer2,
  Scissors,
  SignalHigh,
  SignalLow,
  SignalMedium,
  SquareDashed,
  SquareSplitHorizontal,
  Ungroup,
  UnfoldVertical,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

import type { AppSettings, DisplayMode } from "../ipc";
import type { Tool } from "../state/toolStore";

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
  /// Whether any eligible cut exists for `applyDefaultTransition`
  /// (`useHasTransitionCut` — a boolean project-store selector, so edits
  /// re-render the strip only when cut-existence flips). Existence only; WHICH
  /// cut wins is resolved at dispatch time by the command itself.
  hasTransitionCut: boolean;
  /// Clip snapping — the magnet (`tail_snap_enabled`).
  snapEnabled: boolean;
  /// Whether the timeline pages itself to keep the playhead on screen.
  followPlayhead: boolean;
  /// Whether the preview draws the title-safe / action-safe rectangles.
  safeAreaGuides: boolean;
  /// Preview decode resolution. The strip's `resolution` radio section reads
  /// it; the preview itself subscribes to the store directly.
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
  icon: LucideIcon;
  /// State-bearing glyph, for buttons where the icon itself depicts the
  /// current state rather than a fixed concept. Overrides `icon` when present,
  /// the same way `hint` overrides the command's `labelKey`.
  iconFor?: (state: QuickActionState) => LucideIcon;
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
            ? "timeline.mode_ab_hint"
            : "timeline.mode_all_hint",
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
    // The one-click half of transition discoverability (#16): the button is
    // findable without knowing the right-click-on-a-cut gesture exists. Its
    // own section, not `range`'s — that one is the in/out family.
    id: "transitions",
    mode: "command",
    items: [
      {
        id: "applyDefaultTransition",
        icon: Blend,
        // Same disabled-button rule as `clearRange`: with no eligible cut the
        // hint explains why, instead of restating a label that can't be used.
        hint: (s) =>
          s.hasTransitionCut
            ? "actions.apply_default_transition"
            : "transitions.no_target",
      },
    ],
  },
  {
    // Timeline scale. The `=` / `-` keys have always existed; a trackpad user
    // with no numeric row had no non-keyboard route to them.
    id: "zoom",
    mode: "command",
    items: [
      { id: "zoomTimelineIn", icon: ZoomIn },
      { id: "zoomTimelineOut", icon: ZoomOut },
    ],
  },
  {
    // Preview decode resolution — three absolute choices, NOT one cycling
    // button. From "half" a cycle has no defined direction, the same defect
    // `toolStore.setTool`'s landmine describes for tools; and three
    // idempotent commands are what let this be an honest `radiogroup` rather
    // than a switch claiming a pressed state it hasn't got.
    //
    // A quality ladder, so the glyphs are a ladder: the bars say "more" and
    // "less" at 16 px in a way "1/2" and "1/4" cannot.
    id: "resolution",
    mode: "radio",
    items: [
      {
        id: "setPlaybackResolutionFull",
        icon: SignalHigh,
        active: (s) => s.playbackResolution === "full",
      },
      {
        id: "setPlaybackResolutionHalf",
        icon: SignalMedium,
        active: (s) => s.playbackResolution === "half",
      },
      {
        id: "setPlaybackResolutionQuarter",
        icon: SignalLow,
        active: (s) => s.playbackResolution === "quarter",
      },
    ],
  },
];

/// The glyph to draw for `item` right now. Called per render, so a
/// state-bearing icon can never be cached into a stale component.
export function resolveIcon(
  item: QuickActionItem,
  state: QuickActionState,
): LucideIcon {
  return item.iconFor?.(state) ?? item.icon;
}

/// Flat id list — used by the alignment test and by anything that needs to
/// know whether a command has a strip button.
export const QUICK_ACTION_IDS: readonly string[] = QUICK_ACTION_SECTIONS.flatMap(
  (section) => section.items.map((item) => item.id),
);
