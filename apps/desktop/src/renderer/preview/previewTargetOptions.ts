// The Preview Panel's render-target list: everything the preview can be pointed
// at, in the order and under the names the rest of the app already uses.
//
// Pure — the control holds the subscriptions. The NAMING is not decided here:
// the root prints the timeline Panel's own title (`workspace/timelineTabName.ts`
// — the root is never a noun in the UI, it is the timeline) and a Group prints
// the name its clip and its media-pool card already print
// (`panels/poolItems.ts`). A list where "Group 2" means a different composition
// than the pool's "Group 2" is worse than no list.

import type { ProjectSummary } from "../ipc";
import { groupPoolItems } from "../panels/poolItems";
import { timelineTabLabel } from "../workspace/timelineTabName";

/// The value the control carries for *follow focus*. Not a composition id, and
/// no uuid can collide with it, because following is not a composition.
export const FOLLOW_FOCUS_VALUE = "follow-focus";

export interface PreviewTargetOption {
  /// The composition this entry names; null is *follow focus*.
  compositionId: string | null;
  label: string;
  /// A composition no Group clip references. Selectable — an orphan renders
  /// like any other composition — and marked, the way the media pool marks it.
  isolated: boolean;
}

/// `ordinals` and `refCounts` are the project store's per-summary indices, and
/// `timelinePanelTitle` the translated Panel title the root reads as. Passed in
/// rather than derived so this stays a pure function of its arguments.
export function previewTargetOptions(
  summary: ProjectSummary | null,
  ordinals: ReadonlyMap<string, number>,
  refCounts: ReadonlyMap<string, number>,
  timelinePanelTitle: string,
  t: (key: string, values: Record<string, unknown>) => string,
): PreviewTargetOption[] {
  const followFocus: PreviewTargetOption = {
    compositionId: null,
    label: t("preview.target_follow_focus", {}),
    isolated: false,
  };
  if (!summary) return [followFocus];
  return [
    followFocus,
    {
      compositionId: summary.root_id,
      label: timelineTabLabel(
        summary,
        summary.root_id,
        ordinals,
        timelinePanelTitle,
        t,
      ),
      isolated: false,
    },
    ...groupPoolItems(summary, ordinals, refCounts, t).map((item) => ({
      compositionId: item.id,
      label: item.name,
      isolated: item.refCount === 0,
    })),
  ];
}

/// The two halves of the string boundary `AppSelect` imposes: a stored choice
/// becomes a value, a chosen value becomes a stored choice.
export function targetOptionValue(compositionId: string | null): string {
  return compositionId ?? FOLLOW_FOCUS_VALUE;
}

export function targetOptionChoice(value: string): string | null {
  return value === FOLLOW_FOCUS_VALUE ? null : value;
}
