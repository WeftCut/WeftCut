// What the Link / Unlink toggle would do to the current selection.
//
// Lifted out of Timeline because the Quick Actions strip has to render the same
// gate it dispatches: the strip is a Dock Panel, so it cannot read Timeline's
// locals, and `CommandDef.enabled` is evaluated during the strip's own render
// (`quickActions.ts`). Without a gate the button would look live and do
// nothing — the command itself already returns early on an empty target.
//
// One toggle, two directions (Premiere's Ctrl+L): a selection that sits inside
// ONE link unlinks it; two or more layers that belong to no link get linked.
// Anything else — a single unlinked layer, or a selection mixing linked and
// unlinked layers or spanning two links — is disabled, and the state names why
// so the strip's tooltip can say it.
//
// The predicate comes in an imperative and a hook form, for the reason
// `applyTransition.ts`'s `hasTransitionCut` pair does: the command's gate runs
// inside `listCommands()` where there is no React, and a button that renders
// greyed-out needs a SUBSCRIPTION or it never re-evaluates.

import type { LinkSummary } from "../ipc";
import { linkOverrideOn } from "../state/linkOverrideStore";
import { useCompositionScopeStore } from "../state/compositionScopeStore";
import {
  compositionOrRoot,
  currentOpenComposition,
  useProjectStore,
} from "../state/projectStore";
import { useSelectionStore } from "../state/selectionStore";

/**
 * Whether an edit fans out across the link right now.
 *
 * ONE predicate for every site that consults link membership — click
 * selection, the drag hook's subject set and every IPC it commits, the blade
 * and `splitAtPlayhead`, the marquee, the `enabled` toggle — so "when does a
 * link apply" has exactly one answer. False under the session-wide link
 * override (`linkOverrideStore.ts`) or when the gesture's own `Alt` is held;
 * the two are the same escape at two time scales, which is why neither site
 * re-derives the rule.
 *
 * `e` is optional because the override alone decides for the sites with no
 * gesture (a command run from the palette, the inspector's checkbox).
 */
export function linkFanoutActive(e?: { altKey: boolean }): boolean {
  return !linkOverrideOn() && !(e?.altKey ?? false);
}

/// Stable empty reference. A fresh `[]` per selector call would defeat the
/// reference-equality bail-out the hooks below rely on.
const NO_LINKS: readonly LinkSummary[] = [];

/// `link` / `unlink` are the two live directions; the other two are the
/// disabled reasons, one per tooltip string.
export type LinkToggleState = "link" | "unlink" | "needs_two" | "mixed";

/// The one link every selected layer belongs to, or null. A single member is
/// enough — an `Alt`-click selects one layer out of a link — and so is the
/// whole-link selection a plain click produces.
export function enclosingLink(
  selected: ReadonlySet<string>,
  links: readonly LinkSummary[],
): LinkSummary | null {
  if (selected.size === 0) return null;
  for (const link of links) {
    const members = new Set(link.layer_ids);
    let inside = true;
    for (const id of selected) {
      if (!members.has(id)) {
        inside = false;
        break;
      }
    }
    if (inside) return link;
  }
  return null;
}

export function linkToggleState(
  selected: ReadonlySet<string>,
  links: readonly LinkSummary[],
): LinkToggleState {
  if (enclosingLink(selected, links)) return "unlink";
  const touchesLink = links.some((link) =>
    link.layer_ids.some((id) => selected.has(id)),
  );
  if (touchesLink) return "mixed";
  // `links_create` refuses fewer than two layers.
  return selected.size >= 2 ? "link" : "needs_two";
}

function currentLinks(): readonly LinkSummary[] {
  return currentOpenComposition()?.links ?? NO_LINKS;
}

/// Imperative form, for `CommandDef.enabled` and the Timeline handler.
export function linkToggleForSelection(): LinkToggleState {
  return linkToggleState(
    useSelectionStore.getState().selectedLayerIds,
    currentLinks(),
  );
}

export function canToggleLinkSelection(): boolean {
  const state = linkToggleForSelection();
  return state === "link" || state === "unlink";
}

/**
 * Subscription form — two stores, two subscriptions, neither of them a
 * composite selector (`feedback_zustand_composite_selector`).
 *
 * The selection subscription yields the Set's own reference, which is stable
 * between selection changes; the project subscription closes over it and
 * yields a STRING, so an unrelated project mutation re-runs the predicate and
 * then bails out instead of re-rendering. Doing it the other way round — one
 * selector reading both stores — would subscribe to neither properly.
 */
export const useLinkToggleState = (): LinkToggleState => {
  const selected = useSelectionStore((s) => s.selectedLayerIds);
  const openId = useCompositionScopeStore((s) => s.openId);
  return useProjectStore((s) =>
    linkToggleState(selected, compositionOrRoot(s.summary, openId)?.links ?? NO_LINKS),
  );
};
