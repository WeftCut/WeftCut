// Static defaults — the source of truth for which shortcuts exist.
//
// Each `ActionId` maps to one or more chord strings parsed by `match.ts`
// and a label key reused from the menu's i18n namespace. New shortcuts
// are added by extending the `ActionId` union and `ACTION_DEFS`, then
// wiring the handler in `App.tsx`'s `useShortcuts({...})` call.
// Optional-field semantics live on `ActionDef`'s fields below.

import type { PanelKind } from "../workspace/panelRegistry";

export type ActionId =
  | "save"
  | "saveAs"
  | "closeProject"
  | "undo"
  | "redo"
  | "togglePlay"
  | "selectAll"
  | "deselectAll"
  | "deleteSelected"
  | "copySelected"
  | "pasteAtPlayhead"
  | "splitAtPlayhead"
  | "importMedia"
  | "export"
  | "selectTool"
  | "toggleBladeMode"
  | "toggleLog"
  | "focusLogSearch"
  | "toggleDisplayMode"
  | "toggleFollowPlayhead"
  | "zoomTimelineIn"
  | "zoomTimelineOut"
  | "focusNextPanel"
  | "focusPreviousPanel"
  | "toggleMaximizePanel"
  | "restoreMaximizedPanel"
  | "groupSelected"
  | "ungroupSelected"
  | "openGroup"
  | "addToGroup"
  | "moveToComposition"
  | "autoCaptionSelected"
  | "reviewShots"
  | "toggleLinkSelected"
  | "toggleLinkOverride"
  | "nudgeAudioSampleBack"
  | "nudgeAudioSampleForward"
  | "nudgeAudioMsBack"
  | "nudgeAudioMsForward"
  | "resyncAudioToVideo"
  | "seekFrameBack"
  | "seekFrameForward"
  | "seekSecondBack"
  | "seekSecondForward"
  | "seekPrevEdit"
  | "seekNextEdit"
  | "seekStart"
  | "seekEnd"
  | "markIn"
  | "markOut"
  | "addMarkerAtPlayhead"
  | "seekPrevMarker"
  | "seekNextMarker"
  | "clearRange"
  | "openSearchPalette"
  | "openSettings";

export interface ActionDef {
  defaultKeys: string[];
  labelKey: string;
  /// While an `<input>` / `<textarea>` / `contentEditable` is focused,
  /// chord bindings (Ctrl/Meta/Alt) fire by default and bare keys don't
  /// (derived at `resolveEntries`). Set only to force the opposite for
  /// one action — e.g. copy/paste stay native inside text fields.
  fireWhenEditing?: boolean;
  /// Key-repeat events (`e.repeat === true`) re-fire the handler only
  /// when true; otherwise repeats are consumed without firing — letting
  /// one through would re-arm the focused control's native Space
  /// activation. Set for bindings the user holds down (undo/redo,
  /// arrow seeks).
  repeatable?: boolean;
  /// Dispatch in the keydown CAPTURE phase so the binding wins over a
  /// focused chrome control that would otherwise consume the key
  /// (NLE-style transport). The dispatcher still yields to text editors
  /// and open transient widgets — see `useShortcuts`. Reserve for bare
  /// single keys that read as global app commands.
  captureGlobal?: boolean;
  /// Yield when focus is owned by an open menu, dialog, listbox, or other
  /// transient widget. Workspace navigation uses this even though its chord
  /// does not need capture-phase priority.
  suppressInTransientWidget?: boolean;
  /// Panels this action belongs to (ADR 0041). Absent ⇒ global: transport,
  /// seeking, mark in/out, tool arming, save/export are app commands wherever
  /// focus sits.
  ///
  /// The gate is STRICT — a scoped action yields whenever the active focus
  /// region is not in its list, `null` (app chrome, a dialog, the startup
  /// screen) included. That matches Premiere/Resolve: Delete with the Program
  /// Monitor focused does nothing. It is only safe because `useFocusRegions`
  /// lands focus on a real region for every press on panel content, so a user
  /// who can see a selection has already focused the panel holding it.
  scope?: readonly PanelKind[];
}

/// Actions that operate on the TIMELINE's selection. A literal rather than a
/// `PANEL_KINDS` lookup so this module stays type-only against the panel
/// registry (which pulls in i18n).
///
/// Widening this to `["timeline", "attribute", "effect"]` is the one-line
/// change if "Delete while the Attribute panel is focused" starts reading as a
/// bug — the property panels edit the timeline selection, so an argument
/// exists. Premiere/Resolve are strict, so strict is where this starts.
const TIMELINE_SELECTION: readonly PanelKind[] = ["timeline"];

export const ACTION_DEFS: Record<ActionId, ActionDef> = {
  save:            { defaultKeys: ["Mod+S"],               labelKey: "actions.save" },
  saveAs:          { defaultKeys: ["Mod+Shift+S"],         labelKey: "actions.save_as" },
  closeProject:    { defaultKeys: ["Mod+W"],               labelKey: "actions.save_and_close" },
  // Project history, and only outside a text field: inside one, Cmd+Z means
  // "undo my typing", which the platform already does — the macOS Edit menu's
  // `role: 'undo'` and Chromium's own editor elsewhere. Consuming the chord
  // there (the chord default) suppressed both and silently reverted a project
  // edit instead. Same reasoning as copy/paste below.
  undo:            { defaultKeys: ["Mod+Z"],               labelKey: "actions.undo", repeatable: true, fireWhenEditing: false },
  redo:            { defaultKeys: ["Mod+Shift+Z"],         labelKey: "actions.redo", repeatable: true, fireWhenEditing: false },
  // captureGlobal: Space must toggle playback even when focus is parked on a
  // menubar trigger / toolbar button after a click — a Base UI trigger would
  // otherwise treat Space as "open the menu".
  togglePlay:      { defaultKeys: ["Space"],               labelKey: "actions.toggle_play", captureGlobal: true },
  // Whole-selection commands, at the keys Premiere, Resolve and FCP all agree
  // on. Nothing else in this app claims `Mod+A`.
  //
  // `fireWhenEditing: false` for the copy/paste reason, and here it is what
  // makes text selection work at all: inside a rename field or a numeric input
  // `Mod+A` has to stay the platform's "select all text". Standing down WITHOUT
  // `preventDefault` is also what lets the chord fall through to the macOS
  // `role: 'editMenu'` Select All (`main/appMenu.ts`).
  //
  // `scope` matches `deleteSelected` — with the media pool focused, `Mod+A` is
  // not "select every clip in the timeline". The handlers live in Timeline
  // rather than App's catalogue because Timeline is the only place that knows
  // which tracks are RENDERED: A/B Roll display mode hides role-less tracks, and
  // a Select All reaching them would arm a Delete for clips that are off screen.
  selectAll:       { defaultKeys: ["Mod+A"],               labelKey: "actions.select_all",   fireWhenEditing: false, scope: TIMELINE_SELECTION },
  deselectAll:     { defaultKeys: ["Mod+Shift+A"],         labelKey: "actions.deselect_all", fireWhenEditing: false, scope: TIMELINE_SELECTION },
  deleteSelected:  { defaultKeys: ["Delete", "Backspace"], labelKey: "actions.delete_selected", scope: TIMELINE_SELECTION },
  // Clipboard actions belong to the timeline, not an active text editor. The
  // explicit false preserves native copy/paste inside inputs and text fields;
  // `scope` is the coarser statement of the same idea — with the preview or the
  // media pool focused, Ctrl+C is not "copy my timeline selection".
  copySelected:    { defaultKeys: ["Mod+C"],               labelKey: "actions.copy_selected", fireWhenEditing: false, scope: TIMELINE_SELECTION },
  pasteAtPlayhead: { defaultKeys: ["Mod+V"],               labelKey: "actions.paste_at_playhead", fireWhenEditing: false, scope: TIMELINE_SELECTION },
  // Cut at the playhead — the one edit that earns a chord outright, and the
  // Blade's keyboard half (the tool can only cut where the pointer is). `Mod+B`
  // rather than Premiere's `Mod+K` because `Mod+K` is the search palette here;
  // `Mod+B` is FCP's and CapCut's key for the same operation, so it is not an
  // invention. `fireWhenEditing: false` for the copy/paste reason above and one
  // more: inside a text field the platform reads Ctrl+B as "bold", and a clip
  // silently splitting while a layer is being renamed is the worst version of
  // this key. `scope` matches `deleteSelected` — with the media pool focused,
  // Ctrl+B is not an edit to the timeline.
  splitAtPlayhead: { defaultKeys: ["Mod+B"],               labelKey: "actions.split_at_playhead", fireWhenEditing: false, scope: TIMELINE_SELECTION },
  importMedia:     { defaultKeys: ["Mod+I"],               labelKey: "actions.import_media" },
  export:          { defaultKeys: ["Mod+E"],               labelKey: "actions.export" },
  // Modal timeline tools, one key per tool (`toolStore.ts`): `V` arms
  // Selection, `C` arms the Blade. Both are IDEMPOTENT — pressing a tool's
  // key twice keeps that tool. `Esc` also returns to Selection (handled in
  // Timeline). While the Blade is armed, clicking a layer splits it at the
  // click point (snapped to the composition-frame grid) instead of
  // selecting/dragging it. Bare-letter chords don't fire in text inputs.
  //
  // `toggleBladeMode` keeps its historical id so users' persisted keybinding
  // overrides survive; it no longer toggles — it selects the Blade.
  selectTool:      { defaultKeys: ["V"],                   labelKey: "actions.select_tool" },
  toggleBladeMode: { defaultKeys: ["C"],                   labelKey: "actions.toggle_blade_mode" },
  toggleLog:       { defaultKeys: ["Mod+`"],               labelKey: "actions.toggle_log" },
  focusLogSearch:  { defaultKeys: ["Mod+Shift+`"],         labelKey: "actions.focus_log_search" },
  // Bare-letter `T` flips the app-level `display_mode` (A/B Roll ↔ All Tracks, see
  // `shared/app-settings.ts`). Rebindable through Settings → Keyboard.
  // Bare-letter chords don't fire in text inputs by default.
  toggleDisplayMode: { defaultKeys: ["T"],                 labelKey: "actions.toggle_display_mode" },
  // Whether the timeline pages its view to keep the playhead on screen
  // (`timeline/followPlayhead.ts`). Shift+F rather than a bare letter: the
  // single-key space is reserved for the tools and mark points a user hits
  // hundreds of times a session, and this is a preference they flip when a
  // manual inspection needs the view to hold still.
  toggleFollowPlayhead: { defaultKeys: ["Shift+F"],        labelKey: "actions.toggle_follow_playhead" },
  // Timeline zoom, at the Premiere/FCP7 key positions. One press is one
  // doubling, anchored on the playhead (`timeline/zoom.ts`) — the wheel gesture
  // anchors the cursor, and a key press has no pointer to anchor.
  //
  // LANDMINE: these cannot be `Mod+=` / `Mod+-`, the other half of the
  // convention. `hardenWindow` (main/windows.ts) consumes every Ctrl/Cmd
  // +/-/0 at `before-input-event` to kill Chromium's page zoom, which shrinks
  // the whole application — and that `preventDefault()` stops the keydown from
  // reaching the renderer at all, so the binding would look correct in Settings
  // → Keyboard and never fire.
  //
  // Bare keys, so they stay dead while a text field is focused (the default for
  // non-chord bindings) and the user can still type a minus into a numeric
  // field. UNSCOPED like the transport keys rather than timeline-scoped: the
  // timeline is the only zoomable surface in the app, so `=` means the same
  // thing with the preview or the media pool focused, and the handler is
  // registered by Timeline — with the panel closed the key is inert anyway.
  //
  // Not `repeatable`: a held key would cross the whole range in a third of a
  // second. The wheel is the gesture for sweeping through scales.
  zoomTimelineIn:  { defaultKeys: ["="],                   labelKey: "actions.zoom_timeline_in" },
  zoomTimelineOut: { defaultKeys: ["-"],                   labelKey: "actions.zoom_timeline_out" },
  focusNextPanel: {
    defaultKeys: ["Ctrl+Shift+Period"],
    labelKey: "actions.focus_next_panel",
    fireWhenEditing: false,
    suppressInTransientWidget: true,
  },
  focusPreviousPanel: {
    defaultKeys: ["Ctrl+Shift+Comma"],
    labelKey: "actions.focus_previous_panel",
    fireWhenEditing: false,
    suppressInTransientWidget: true,
  },
  toggleMaximizePanel: {
    defaultKeys: ["Backquote"],
    labelKey: "actions.toggle_maximize_panel",
    fireWhenEditing: false,
    suppressInTransientWidget: true,
  },
  restoreMaximizedPanel: {
    defaultKeys: ["Escape"],
    labelKey: "actions.restore_maximized_panel",
    fireWhenEditing: false,
    suppressInTransientWidget: true,
  },
  // `docs/features.md#groups` — pre-compose and its inverse, at the keys AE
  // (`Mod+Shift+C` for precompose) declined to standardise and Premiere,
  // Resolve and every other layer-based tool did: `Mod+G` groups, `Mod+Shift+G`
  // ungroups. Two commands and not one toggle for the reason
  // `timeline/groupEligibility.ts` gives: their preconditions are not inverses.
  //
  // NOT `fireWhenEditing: false`, unlike the clipboard chords: no platform or
  // editor meaning is attached to Ctrl+G in a text field here, and the scope
  // gate below already stands the pair down everywhere but the timeline.
  groupSelected:          { defaultKeys: ["Mod+G"],        labelKey: "actions.group_selected", scope: TIMELINE_SELECTION },
  ungroupSelected:        { defaultKeys: ["Mod+Shift+G"],  labelKey: "actions.ungroup_selected", scope: TIMELINE_SELECTION },
  // Entering a Group ships UNBOUND. Its home is the pointer — a double-click on
  // the clip, a tab in the Dock's strip — and no shipping NLE has a key for it
  // to copy, so spending one from the budget would be inventing a convention.
  // It is catalogued anyway, which is what puts it in the palette, in the Edit
  // menu and in Settings → Keyboard for a user who wants to bind it;
  // `resolveEntries` simply emits no chord for an empty `defaultKeys`.
  //
  // There is no leaving half: a timeline Panel is one composition (ADR 0053),
  // so leaving is closing its tab or activating another — the Dock's own
  // gestures, which need no action of ours.
  openGroup:              { defaultKeys: [],               labelKey: "actions.open_group", scope: TIMELINE_SELECTION },
  // Adding to a Group ships UNBOUND for `openGroup`'s reason: it is pointer
  // first. You reach it by right-clicking the Group you mean, which is also the
  // only surface that can name that Group in the row
  // (`menu/CommandContextItem.tsx` owns that split). Catalogued anyway, so the
  // Edit menu, the palette and Settings → Keyboard all carry it.
  addToGroup:             { defaultKeys: [],               labelKey: "actions.add_to_group", scope: TIMELINE_SELECTION },
  // The crossing addressed by NAMING a destination, unbound for the same reason
  // and one more: the act is incomplete without a destination, and a key can
  // carry none. Its home is the clip menu's *Move to… ›* submenu, where every
  // destination is a row; the catalogued form here means the ROOT — the one
  // destination a surface with no list can name unambiguously, which is why
  // this label says *Move to timeline* where the trigger says only *Move to…*
  // — and greys where the selection is already there
  // (`timeline/moveToCompositionEligibility.ts`).
  moveToComposition:      { defaultKeys: [],               labelKey: "actions.move_to_composition", scope: TIMELINE_SELECTION },
  // Transcribe the selected clip and apply the cues. Catalogued here rather
  // than as a menu-only command, for `openGroup`'s reason and `addToGroup`'s
  // shape: it acts on the timeline SELECTION, so `scope` is the gate that keeps
  // it from firing with the media pool focused, and a user who captions every
  // clip has somewhere to bind it (Settings → Keyboard) — which a menu-only
  // command has not. Unbound by default because its home is the pointer: you
  // right-click the clip you mean.
  //
  // No `cut-silences` twin beside it: that recipe's apply step needs a ripple
  // delete this editor does not have, so it stays out of the menus entirely.
  autoCaptionSelected:    { defaultKeys: [],               labelKey: "actions.auto_caption_selected", scope: TIMELINE_SELECTION },
  // Open the shot-review Panel on the selected clip. Catalogued here and not as
  // a menu-only command, for `autoCaptionSelected`'s reason and against
  // `openVoiceoverDialog`'s: this one HAS a scope. What it reviews is the
  // primary timeline selection, so `scope` is the gate that keeps a bare key
  // from firing with the media pool focused, and a user who reviews every clip
  // has somewhere to bind it (Settings → Keyboard) — which `openAgentPanel`,
  // the other Panel-opening command, deliberately has not, because that one
  // acts on no object at all.
  //
  // Unbound by default because its home is the pointer: you right-click the
  // clip you mean, and the right-click has already selected it. The Panel also
  // appears in the View menu's Panels list for free — that list maps over
  // `PANEL_KINDS`.
  reviewShots:            { defaultKeys: [],               labelKey: "actions.review_shots", scope: TIMELINE_SELECTION },
  // `docs/features.md#links` — Ctrl/Cmd+L toggles the link on the current
  // selection, Premiere's Link: two or more unlinked layers link, a selection
  // inside one link unlinks it (`timeline/linkEligibility.ts` decides).
  // Handler lives in Timeline.tsx, while the complete selection itself is
  // renderer-global. Surfaced here so the Keyboard Shortcuts panel shows it
  // and the user can rebind.
  toggleLinkSelected:     { defaultKeys: ["Mod+L"],        labelKey: "actions.toggle_link_selected", scope: TIMELINE_SELECTION },
  // Link override — the held-`Alt` escape as a switch (`linkOverrideStore.ts`).
  // Reaper's *Grouping enabled* key; nothing else here claims `Alt+Shift+G`
  // (the audio slip family below takes `Alt+Shift+Arrow` and `Alt+Shift+S`).
  // Handled in App so the catalogue lists it, timeline-scoped because it only
  // changes what timeline gestures do.
  toggleLinkOverride:     { defaultKeys: ["Alt+Shift+G"],  labelKey: "actions.toggle_link_override", scope: TIMELINE_SELECTION },
  // Sub-frame audio slip (ADR 0038). Deliberately UNSCOPED, unlike its
  // structural siblings above: nudging audio sync while watching and listening
  // to the preview is the workflow these keys exist for, and scoping Alt+Arrow
  // to the timeline would kill it exactly when it is most useful. Two tiers because ONE SAMPLE is 0.042 px at the
  // 2000 px/s zoom ceiling — sample precision is unreachable by dragging, so keys and
  // numbers are the entry points, and a single-sample step alone would be unusable
  // for a real ~ms sync fix. Alt+Arrow is free (bare arrows are the playhead seek).
  // Repeatable so holding the key walks; each press steps by an INDEX, so 10 000
  // presses out and back land on the original sample exactly.
  nudgeAudioSampleBack:    { defaultKeys: ["Alt+ArrowLeft"],        labelKey: "actions.nudge_audio_sample_back",    repeatable: true },
  nudgeAudioSampleForward: { defaultKeys: ["Alt+ArrowRight"],       labelKey: "actions.nudge_audio_sample_forward", repeatable: true },
  nudgeAudioMsBack:        { defaultKeys: ["Alt+Shift+ArrowLeft"],  labelKey: "actions.nudge_audio_ms_back",        repeatable: true },
  nudgeAudioMsForward:     { defaultKeys: ["Alt+Shift+ArrowRight"], labelKey: "actions.nudge_audio_ms_forward",     repeatable: true },
  // Zero the derived sync offset — the companion to the nudges, since the offset is
  // geometry with no field to reset.
  resyncAudioToVideo:      { defaultKeys: ["Alt+Shift+S"],          labelKey: "actions.resync_audio_to_video" },
  // Playhead movement — composition-frame grid. Repeatable so holding
  // the arrow steps continuously.
  seekFrameBack:     { defaultKeys: ["ArrowLeft"],         labelKey: "actions.seek_frame_back",     repeatable: true },
  seekFrameForward:  { defaultKeys: ["ArrowRight"],        labelKey: "actions.seek_frame_forward",  repeatable: true },
  seekSecondBack:    { defaultKeys: ["Shift+ArrowLeft"],   labelKey: "actions.seek_second_back",    repeatable: true },
  seekSecondForward: { defaultKeys: ["Shift+ArrowRight"],  labelKey: "actions.seek_second_forward", repeatable: true },
  // Edit-point navigation (Premiere-style ↑/↓): parks the playhead ON the
  // cut, which displays the incoming clip's first frame; one ← from there
  // shows the outgoing clip's last frame. See docs/data-model.md (boundary
  // semantics).
  seekPrevEdit:      { defaultKeys: ["ArrowUp"],           labelKey: "actions.seek_prev_edit",      repeatable: true },
  seekNextEdit:      { defaultKeys: ["ArrowDown"],         labelKey: "actions.seek_next_edit",      repeatable: true },
  seekStart:         { defaultKeys: ["Home"],              labelKey: "actions.seek_start" },
  seekEnd:           { defaultKeys: ["End"],               labelKey: "actions.seek_end" },
  // Timeline in/out points (`rangeStore.ts`) at the Premiere/Resolve key
  // positions. Bare letters, so they stay dead inside text fields. NOT
  // captureGlobal: unlike Space, `I`/`O` mean nothing to a focused button, so
  // there is no chrome control to win the key back from.
  //
  // Each is IDEMPOTENT — pressing `I` twice at one playhead leaves the same in
  // point — so neither is `repeatable`; holding the key marks nothing new.
  markIn:            { defaultKeys: ["I"],                 labelKey: "actions.mark_in" },
  markOut:           { defaultKeys: ["O"],                 labelKey: "actions.mark_out" },
  // Marker at the playhead, at the key every NLE gives it. Same shape as
  // `markIn`/`markOut` and for the same reasons: bare letter (dead in text
  // fields), not captureGlobal, deliberately UNSCOPED — the preview is where a
  // user watches, so a scoped M would be dead exactly where marking happens.
  // Not `repeatable`: the second press on a marked frame OPENS RENAME rather
  // than stacking a duplicate, so holding the key must not re-fire.
  addMarkerAtPlayhead: { defaultKeys: ["M"],               labelKey: "actions.add_marker_at_playhead" },
  // Walking the marks, at Premiere's pairing for it. UNSCOPED for the reason
  // `M` is: you step between marks while WATCHING, so a timeline-scoped binding
  // would be dead exactly where the walk is used. WHICH composition gets walked
  // is answered by reading focus at press time (`state/navigation.ts`), never by
  // a registration scope.
  //
  // Repeatable, unlike `M`: neither direction has a second-press meaning to
  // re-arm, and the walk does not wrap, so a held key stops at the end of the
  // list instead of cycling.
  //
  // `fireWhenEditing: false` on the chord half ONLY, and it is what keeps the
  // pair symmetric rather than what makes it asymmetric: Shift-only reads as
  // typing and stands down in a text field already, so without this its partner
  // would be the one key of the two that moves the film while you name a marker.
  // The Group chords go without it because their scope gate stands them down;
  // walking marks is deliberately unscoped, so it has no other gate to inherit.
  seekPrevMarker:    { defaultKeys: ["Mod+Shift+M"],       labelKey: "actions.seek_prev_marker",    repeatable: true, fireWhenEditing: false },
  seekNextMarker:    { defaultKeys: ["Shift+M"],           labelKey: "actions.seek_next_marker",    repeatable: true },
  clearRange:        { defaultKeys: ["Alt+X"],             labelKey: "actions.clear_range" },
  // Global search palette. A chord, so it fires while a text input is
  // focused (default chord behavior) — expected for a Spotlight-style UI.
  openSearchPalette: { defaultKeys: ["Mod+K"], labelKey: "actions.open_search" },
  // App preferences, at the Mac convention. Catalogued rather than hard-wired
  // into the macOS App menu that projects it, so the chord is rebindable,
  // listed in Settings → Keyboard, and the same on every platform.
  openSettings: { defaultKeys: ["Mod+Comma"], labelKey: "actions.settings" },
};

export const ACTION_IDS = Object.keys(ACTION_DEFS) as ActionId[];
