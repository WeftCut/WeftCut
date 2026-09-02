// The menu bar's structure book: which commands appear in which dropdown, in
// what order, with which separators. Everything else about an item — label,
// handler, enabled/checked state, shortcut hint — is looked up in the command
// registry at render time (`CommandMenu.tsx`), so this file and `ACTION_DEFS`
// cannot drift: adding a menu command means one entry in the registry's
// catalog and one id here.
//
// Structure stays a static tree rather than placement metadata on each
// CommandDef because menu order is an editorial decision, not command state —
// the same judgement `shared/menu.ts` makes when it gives main the native
// menu's structure but not its labels.
//
// Ids are type-locked to the union of catalogued actions and menu-only
// commands; a typo or a removed command fails `tsc`, not the user.

import type { ActionId } from "../shortcuts/defs";
import type { MenuOnlyCommandId } from "../commands/appCommands";

export type MenuCommandId = ActionId | MenuOnlyCommandId;

export type MenuSpecEntry =
  | MenuCommandId
  /// Object form for items carrying a tooltip — a menu-presentation detail,
  /// so it lives here rather than on CommandDef.
  | { id: MenuCommandId; hintKey: string }
  | "---";

export interface MenuSection {
  titleKey: string;
  entries: readonly MenuSpecEntry[];
}

export const FILE_MENU: MenuSection = {
  titleKey: "menu.file",
  entries: [
    "importMedia",
    "---",
    "save",
    "saveAs",
    { id: "closeProject", hintKey: "actions.save_and_close_hint" },
    "---",
    "export",
    "---",
    // Stays here on every platform for cross-platform consistency, even though
    // macOS ALSO projects it into the App menu under Cmd+, — the two dispatch
    // the same action (ADR 0031).
    { id: "openSettings", hintKey: "actions.settings_hint" },
  ],
};

export const EDIT_MENU: MenuSection = {
  titleKey: "menu.edit",
  entries: [
    "undo",
    "redo",
    // Sits with Undo/Redo because it is the same faculty — a way back — not
    // with the View menu's panel toggles. The hint carries the session-only
    // caveat, since the command can be run without ever opening the History
    // Panel where that copy otherwise lives.
    { id: "createCheckpoint", hintKey: "actions.create_checkpoint_hint" },
    "---",
    // Modal tools: checkmarks make the armed tool visible here too, so blade
    // mode isn't discoverable only by the timeline cursor. Selection is always
    // available; the Blade needs a layer to cut.
    "selectTool",
    "toggleBladeMode",
    // The Blade without the pointer: same cut, resolved from the playhead. It
    // sits with the tools rather than in a section of its own because that is
    // the relationship a user needs to see — reach for the tool to cut where
    // you point, reach for this to cut where you are.
    "splitAtPlayhead",
    "---",
    // Z-order rearrangement, and the only route to a new lane that needs no
    // pointer. Its home is Edit rather than a clip-scoped or top-level section:
    // there is no clip menu, and a new section would pull in `AppMenuBar` and
    // the native-menu path for one item.
    "moveToNewTrack",
    "---",
    // The Group section (`docs/features.md#groups`). Its own group of rows
    // rather than beside the tools above, because these are structural — they
    // change what the timeline CONTAINS — while Blade and Split change where a
    // clip is cut. Make one, dissolve one, add to one, move out of one: the
    // four edits in that order, then Enter under them as the navigation half.
    // The last three ship unbound, which is exactly why they are here and not
    // only on the clip's context menu — the menu is the discoverable path to a
    // gesture no key reaches.
    //
    // Move to composition follows Add to Group because the two are one act seen
    // from either end — point at the destination, or name it — and the pointed
    // one is what a user finds first. This row carries no destination list, so
    // it means the root: "put these back into the film", greyed once they are
    // (`commands/groupCommands.ts`). The clip menu's submenu has the full list.
    "groupSelected",
    "ungroupSelected",
    "addToGroup",
    "moveToComposition",
    "openGroup",
    "---",
    // Clip analysis and speech. Last in Edit and in their own group because
    // these are the rows that ask a question ABOUT the material rather than
    // editing it — listen to a clip, measure its silence, look at its content,
    // speak a script — and none of them belongs beside the structural edits
    // above. The first three are also on the clip's context menu, which is
    // their pointer home; voiceover is only here and in the palette, because it
    // acts on no clip at all. There is no aggregate "AI" menu on purpose: each
    // capability hangs off the object it acts on, and a script has none.
    //
    // Describe sits last of the three that take a clip: it is the one whose
    // answer is prose rather than a timeline edit, and the one that costs ~20 s
    // of local model time.
    "autoCaptionSelected",
    "detectSilencesSelected",
    "describeSelected",
    "openVoiceoverDialog",
  ],
};

export const INSERT_MENU: MenuSection = {
  titleKey: "menu.insert",
  entries: [
    "addColorLayer",
    "addTextLayer",
    { id: "openMotifPicker", hintKey: "actions.motifs_hint" },
  ],
};

/// Every spec-driven section, for tests that sweep the whole book. The bar
/// itself places these explicitly in `AppMenuBar` — the bespoke menus (View,
/// Help, Dev) interleave between them.
export const MENU_SPEC: readonly MenuSection[] = [
  FILE_MENU,
  EDIT_MENU,
  INSERT_MENU,
];
