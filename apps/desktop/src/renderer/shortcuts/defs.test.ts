import { describe, expect, it } from "vitest";

import { ACTION_DEFS, ACTION_IDS } from "./defs";
import { bindingsEqual, parseBinding } from "./match";

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
