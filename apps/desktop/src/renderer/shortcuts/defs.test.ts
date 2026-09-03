import { describe, expect, it } from "vitest";

import { ACTION_DEFS, ACTION_IDS, type ActionId } from "./defs";
import { bindingsEqual, parseBinding } from "./match";
import enUS from "../i18n/locales/en-US";
import zhCN from "../i18n/locales/zh-CN";

// The catalogue read as a whole, which nothing else in the suite does.
//
// `ACTION_DEFS` is one flat table, and both ways of getting it wrong are
// SILENT: two actions claiming the same chord means the dispatcher fires
// whichever it resolves first and the loser is simply dead, and a mistyped
// chord throws inside `resolveEntries` at mount rather than at compile. Neither
// is visible from a feature test of either action.

describe("ACTION_DEFS", () => {
  it("gives no default chord to two actions at once", () => {
    const bound = ACTION_IDS.flatMap((id) =>
      ACTION_DEFS[id].defaultKeys.map((spec) => ({ id, spec })),
    );
    // `bindingsEqual` and not string equality: `Mod` resolves per platform, so
    // `Mod+S` and `Ctrl+S` are the same key on Windows and Linux while reading
    // as two different table entries.
    const clashes: string[] = [];
    for (let i = 0; i < bound.length; i += 1) {
      for (let j = i + 1; j < bound.length; j += 1) {
        const a = bound[i]!;
        const b = bound[j]!;
        if (bindingsEqual(a.spec, b.spec)) {
          clashes.push(`${a.spec} — ${a.id} vs ${b.id}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it("parses every default chord it declares", () => {
    // Load-bearing beside the clash sweep above, not redundant with it:
    // `bindingsEqual` swallows a parse failure and answers "not equal", so an
    // unparseable chord would pass that test while being dead at runtime.
    for (const id of ACTION_IDS) {
      for (const spec of ACTION_DEFS[id].defaultKeys) {
        expect(() => parseBinding(spec), `${id}: "${spec}"`).not.toThrow();
      }
    }
  });
});

/// Every action whose handler chooses its subject from whichever selection is
/// armed. Their labels can name only one of the two things the key does, so the
/// panel is not merely terse without a hint — it is wrong about half the
/// presses. Listed by hand: the dispatch happens inside a handler, and no shape
/// in the catalogue can be read to derive it.
const DUAL_DISPATCH_ACTIONS: ActionId[] = [
  "nudgeBack",
  "nudgeForward",
  "nudgeLargeBack",
  "nudgeLargeForward",
  "deleteSelected",
  "copySelected",
  "pasteAtPlayhead",
];

/// Follows a dotted i18n key through a locale object; `null` when any step is
/// missing or the leaf is not a string.
function lookup(locale: unknown, key: string): string | null {
  let node: unknown = locale;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

describe("keyboard-panel hints", () => {
  it("gives every selection-dispatching action a hint", () => {
    const missing = DUAL_DISPATCH_ACTIONS.filter((id) => !ACTION_DEFS[id].hintKey);
    expect(missing).toEqual([]);
  });

  it("resolves every declared hint in both locales", () => {
    // A missing key renders as the key itself, which reads as a bug report in
    // the UI rather than failing anywhere — so the sweep is the only guard.
    const unresolved: string[] = [];
    for (const id of ACTION_IDS) {
      const key = ACTION_DEFS[id].hintKey;
      if (key === undefined) continue;
      for (const [name, locale] of [
        ["en-US", enUS],
        ["zh-CN", zhCN],
      ] as const) {
        if (lookup(locale, key) === null) unresolved.push(`${name}: ${key}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("resolves every action label in both locales", () => {
    // The hint sweep above would pass a rename that dropped the LABEL key with
    // it, and a label is what the row is identified by.
    const unresolved: string[] = [];
    for (const id of ACTION_IDS) {
      for (const [name, locale] of [
        ["en-US", enUS],
        ["zh-CN", zhCN],
      ] as const) {
        if (lookup(locale, ACTION_DEFS[id].labelKey) === null) {
          unresolved.push(`${name}: ${ACTION_DEFS[id].labelKey}`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});
