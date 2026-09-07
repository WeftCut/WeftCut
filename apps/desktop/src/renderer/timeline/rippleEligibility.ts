// What Ripple delete would do to the current selection, and why not when not.
//
// ONE predicate for FOUR surfaces — the clip menu's row, the Quick Actions
// strip, the Edit menu / palette entry's `enabled`, and the key itself — for
// `groupEligibility.ts`'s reason: the strip is a Dock Panel that cannot read
// Timeline's locals, and `CommandDef.enabled` is evaluated during the strip's
// own render, so a subscribed form is the only one that re-evaluates. It is
// also `plan.ts`'s reason, one level up: the arithmetic the mutation applies and
// the arithmetic that greys the row are the same call, so the promise the UI
// makes and the edit the actor performs cannot disagree.
//
// The difference from every other eligibility table here is where the sentence
// comes from. Group / Add to Group answer with a state whose reason is a fixed
// string; a refused ripple answers with the actor's own `CommandError`, and its
// sentence is composed by `errors/formatCommandError.ts` — the same curated copy
// the status bar shows when the refusal arrives for real. One sentence, three
// places, no second wording to keep in step.
//
// THE MIRROR CAN BE TWO ROUND TRIPS BEHIND
// (`feedback_renderer_mirror_read_modify_write`), so this predicate is a
// PREDICTION and not the verdict. When it is wrong the gesture is sent, the
// actor refuses on state the renderer had not seen yet, and the refusal lands on
// the status bar through `logMutationFailure` with the same curated line — no
// toast, no dialog (issue #18). Being stale therefore costs a round trip and a
// status row, never a wrong edit: the actor's validate is the last door.

import type { CommandError } from "../../shared/commandErrors";
import { formatCommandError } from "../errors/formatCommandError";
import type { CompositionSummary } from "../ipc";
import {
  hasKeyframeSelection,
  useKeyframeSelectionStore,
} from "../keyframe/selectionStore";
import { planRipple } from "../ripple/plan";
import { rippleViewOfSummary } from "../ripple/summaryView";
import { useCompositionAnchorStore } from "../state/compositionAnchorStore";
import {
  compositionOrRoot,
  currentOpenComposition,
  useProjectStore,
} from "../state/projectStore";
import {
  currentSelection,
  layerIdsOf,
  useSelectedLayerIds,
} from "../state/selectionStore";

/// `ripple` is the live direction; the rest are the disabled reasons.
///
/// A discriminated union rather than the plain string union the Group gates use,
/// because one arm carries evidence: a refusal names the layer, the link or the
/// lane that blocks, and a bare `"refused"` would leave every surface with
/// nothing to say beyond "no".
///
/// `keyframes` is not a refusal at all — it is the precedence rule showing
/// through. `Shift+Delete` DEGRADES to the keyframe delete when keys are
/// selected, exactly as bare `Delete` does, so the row explains that the key is
/// about to do something else rather than pretending the ripple is available.
export type RippleDeleteState =
  | { kind: "ripple" }
  | { kind: "needs_selection" }
  | { kind: "keyframes" }
  | { kind: "refused"; refusal: CommandError };

/// Interned, for the reason the cache below exists: these three carry no
/// evidence, so a fresh object per evaluation would be a new reference for the
/// same answer.
const RIPPLE: RippleDeleteState = { kind: "ripple" };
const NEEDS_SELECTION: RippleDeleteState = { kind: "needs_selection" };
const KEYFRAMES: RippleDeleteState = { kind: "keyframes" };

/// Why a greyed Ripple delete is greyed, for the two states whose reason is a
/// fixed sentence. The refusal arm is deliberately absent: its sentence comes
/// from the curated refusal copy, not from here, and a second wording would be
/// the drift this whole file exists to prevent. In the `quick_actions` namespace
/// the strip's and the clip menu's other disabled reasons already live in.
const RIPPLE_DELETE_REASON: Record<"needs_selection" | "keyframes", string> = {
  needs_selection: "quick_actions.ripple_needs_selection",
  keyframes: "quick_actions.ripple_keyframes",
};

/**
 * The verdict for one selection against one composition.
 *
 * Pure and injectable, so the surfaces above and the tests below run the same
 * function. "All in one composition" is enforced STRUCTURALLY, as
 * `groupEligibility.ts` enforces it: the walk visits only the focused
 * composition's tracks, so a selected layer that lives elsewhere is simply not
 * found and the answer is `needs_selection` rather than the planner's
 * `LayerNotFound` — a refusal whose sentence would name a uuid the user cannot
 * see.
 */
export function rippleDeleteStateOf(
  selected: ReadonlySet<string>,
  composition: CompositionSummary | null,
  keyframes: boolean,
): RippleDeleteState {
  // Precedence first, before the selection is even read: with keys selected the
  // key does the keyframe delete whatever the clips look like.
  if (keyframes) return KEYFRAMES;
  if (composition === null) return NEEDS_SELECTION;
  const ids: string[] = [];
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (selected.has(layer.id)) ids.push(layer.id);
    }
  }
  if (ids.length === 0) return NEEDS_SELECTION;
  const plan = planRipple(rippleViewOfSummary(composition), ids);
  return plan.ok ? RIPPLE : { kind: "refused", refusal: plan.refusal };
}

/// One-entry memo over the three inputs, and it is a CORRECTNESS device rather
/// than a speed one: the hook below returns this value straight out of a zustand
/// selector, and a selector that builds a fresh object every tick loops
/// `useSyncExternalStore` forever (`feedback_zustand_composite_selector`). Every
/// input is reference-stable between the changes that matter — the selection Set
/// between selection changes, and the composition between summaries, since
/// `compositionOrRoot` hands back a sub-object of the summary — so one entry is
/// enough for every subscriber, which all read the same three stores.
let memo: {
  selected: ReadonlySet<string>;
  composition: CompositionSummary | null;
  keyframes: boolean;
  state: RippleDeleteState;
} | null = null;

function rippleDeleteStateMemo(
  selected: ReadonlySet<string>,
  composition: CompositionSummary | null,
  keyframes: boolean,
): RippleDeleteState {
  if (
    memo !== null &&
    memo.selected === selected &&
    memo.composition === composition &&
    memo.keyframes === keyframes
  ) {
    return memo.state;
  }
  const state = rippleDeleteStateOf(selected, composition, keyframes);
  memo = { selected, composition, keyframes, state };
  return state;
}

/// Imperative form, for `CommandDef.enabled` and the App handler — both run
/// where there is no React.
export function rippleDeleteState(): RippleDeleteState {
  return rippleDeleteStateMemo(
    layerIdsOf(currentSelection()),
    currentOpenComposition(),
    hasKeyframeSelection(),
  );
}

export function canRippleDeleteSelection(): boolean {
  return rippleDeleteState().kind === "ripple";
}

/**
 * Subscription form. Three atomic subscriptions, none of them a composite
 * selector, exactly as `useGroupState` does it — plus the keyframe store, which
 * the Group gates have no reason to read and this one does: the precedence rule
 * is part of the answer, so a diamond click has to re-label the row.
 *
 * The project subscription yields the memo's value, so an unrelated mutation
 * re-runs the predicate and hands back the same reference instead of
 * re-rendering.
 */
export const useRippleDeleteState = (): RippleDeleteState => {
  const selected = useSelectedLayerIds();
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  const keyframes = useKeyframeSelectionStore((s) => s.selected.size > 0);
  return useProjectStore((s) =>
    rippleDeleteStateMemo(
      selected,
      compositionOrRoot(s.summary, focusedId),
      keyframes,
    ),
  );
};

/**
 * The disabled sentence, resolved — or `undefined` when the gesture is live and
 * the row's own label already says everything there is to say.
 *
 * `t` is passed rather than read, so a caller renders in the language it is
 * rendering in; the refusal arm goes through `formatCommandError`'s public entry
 * point, which resolves the uuids to the names the timeline shows and hands back
 * the key plus its arguments. Falling back to the composed `message` covers the
 * refusals filed as plumbing — the planner can still answer `LayerNotFound` off a
 * mirror that has lost the layer between the click and this call — where an
 * English line is better than a raw code.
 */
export function rippleDeleteReason(
  state: RippleDeleteState,
  // The two-required-argument shape `lib/layerName.ts` and `lib/trackName.ts`
  // already take, so a component can hand over `useTranslation`'s `t` unwrapped.
  t: (key: string, values: Record<string, unknown>) => string,
): string | undefined {
  if (state.kind === "ripple") return undefined;
  if (state.kind === "refused") {
    const formatted = formatCommandError(state.refusal);
    return formatted.i18n_key
      ? t(formatted.i18n_key, formatted.i18n_args ?? {})
      : formatted.message;
  }
  return t(RIPPLE_DELETE_REASON[state.kind], {});
}
