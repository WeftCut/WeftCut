import { describe, expect, it } from "vitest";

import { buildAppCommands } from "../commands/appCommands";
import { ACTION_DEFS, type ActionId } from "../shortcuts/defs";
import type { HandlerMap } from "../shortcuts/useShortcuts";
import {
  ANALYSIS_MENU_COMMAND_IDS,
  GROUP_MENU_COMMAND_IDS,
  LAYER_MENU_COMMAND_IDS,
  VIDEO_MENU_COMMAND_IDS,
} from "../timeline/LayerContextMenu";
import { RULER_MENU_COMMAND_IDS } from "../timeline/RulerContextMenu";
import en from "../i18n/locales/en-US";

// `CommandContextItem` takes an untyped `id` on purpose (its docstring says
// why: a context menu's rows reach outside `menuSpec.ts`'s checked union), and
// resolving one that doesn't exist DROPS the row silently rather than failing
// to compile. This file is the safety net that trade needs — the same one
// `quickActions.test.ts` gives the strip.

/// Every catalogued action wired, so the factory emits the full command set.
function allHandlers(): HandlerMap {
  const handlers: HandlerMap = {};
  for (const id of Object.keys(ACTION_DEFS) as ActionId[]) {
    handlers[id] = () => {};
  }
  return handlers;
}

const noop = () => {};

function catalogue() {
  return buildAppCommands(
    allHandlers(),
    {
      addColorLayer: noop,
      addTextLayer: noop,
      openMotifPicker: noop,
      openAgentPanel: noop,
      enterAgentMode: noop,
      createCheckpoint: noop,
      moveToNewTrack: noop,
      toggleMarkersVisible: noop,
      applyDefaultTransition: noop,
      openVoiceoverDialog: noop,
    },
    {
      busy: false,
      canUndo: false,
      canRedo: false,
      canBlade: false,
      exportLocked: false,
    },
  );
}

function resolveKey(obj: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<Record<string, unknown> | undefined>(
      (acc, k) => acc?.[k] as Record<string, unknown> | undefined,
      obj as Record<string, unknown>,
    );
}

const MENUS = {
  "layer context menu": LAYER_MENU_COMMAND_IDS,
  // The kind-gated Group tier of the same popup. Swept separately because it is
  // a separate list, not because it is a separate menu.
  "layer context menu (Group tier)": GROUP_MENU_COMMAND_IDS,
  // The other kind-gated tier of that popup — the rows a clip with audio gets.
  "layer context menu (analysis tier)": ANALYSIS_MENU_COMMAND_IDS,
  // And the narrowest tier — the rows only a picture clip gets.
  "layer context menu (video tier)": VIDEO_MENU_COMMAND_IDS,
  "ruler context menu": RULER_MENU_COMMAND_IDS,
} as const;

describe.each(Object.entries(MENUS))("%s", (_name, entries) => {
  const ids = entries.filter((entry): entry is Exclude<typeof entry, "---"> =>
    entry !== "---",
  );

  // Both menus draw only from App's own catalogue on purpose. A row backed by
  // Timeline's provider (the link toggle, the audio nudges) would vanish
  // whenever the Timeline Panel is closed — and a context menu opened from
  // inside the timeline that silently loses rows is worse than one that never
  // offered them.
  it("resolves every row to a command in App's catalogue", () => {
    const available = new Set(catalogue().map((d) => d.id));
    for (const id of ids) {
      expect(available, `no command registered for "${id}"`).toContain(id);
    }
  });

  it("labels every row in the en-US locale", () => {
    const byId = new Map(catalogue().map((d) => [d.id, d]));
    for (const id of ids) {
      const labelKey = byId.get(id)?.labelKey ?? "";
      expect(typeof resolveKey(en, labelKey), `${id} → ${labelKey}`).toBe(
        "string",
      );
    }
  });

  it("lists no row twice", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  // A separator at either end renders as a stray rule against the popup's own
  // border, and two in a row render as a double rule.
  it("places no separator at an edge or beside another", () => {
    expect(entries[0]).not.toBe("---");
    expect(entries[entries.length - 1]).not.toBe("---");
    for (let i = 1; i < entries.length; i += 1) {
      if (entries[i] === "---") expect(entries[i - 1]).not.toBe("---");
    }
  });
});
