// @vitest-environment jsdom
//
// The Keyboard panel's rows: the hint line under a dual-dispatch action.
// `shortcuts/defs.test.ts` proves every such action's `hintKey` resolves in
// both locales; this is the one place that renders the panel and looks for the
// line. The ipc / dialog bridges are reached only from the toolbar's mutations,
// which these cases never click, so nothing is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import i18n from "../i18n";
import { ACTION_DEFS, ACTION_IDS } from "../shortcuts/defs";
import { KeybindingPanel } from "./KeybindingPanel";

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

function renderPanel() {
  return render(<KeybindingPanel keybindings={{}} onChanged={vi.fn()} onError={vi.fn()} />);
}

/// The row a label sits in, so an assertion is about one action, not the table.
const rowOf = (label: string): HTMLElement => screen.getByText(label).closest("tr")!;

const hintIn = (row: HTMLElement): string | null =>
  row.querySelector(".keybindings-hint")?.textContent ?? null;

describe("KeybindingPanel", () => {
  it("prints the dispatch rule under an action whose key does two things", () => {
    renderPanel();

    expect(hintIn(rowOf("Delete selected layer"))).toBe(i18n.t("hints.delete_selected"));
    expect(hintIn(rowOf("Nudge earlier"))).toBe(i18n.t("hints.nudge_back"));
  });

  it("prints nothing under an action whose label already says everything", () => {
    renderPanel();

    expect(hintIn(rowOf("Play / pause"))).toBeNull();
  });

  it("renders exactly one hint per action that declares one", () => {
    const { container } = renderPanel();

    const declared = ACTION_IDS.filter((id) => ACTION_DEFS[id].hintKey !== undefined).length;
    expect(declared).toBeGreaterThan(0);
    expect(container.querySelectorAll(".keybindings-hint")).toHaveLength(declared);
  });
});
