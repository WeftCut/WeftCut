// The describe gesture as a command: ask a vision model what is in one clip.
//
// Only RAISES a dialog — the two parameters the tool offers are the content of
// the gesture, and a ~20 s model run must not start on a bare press. The work
// itself lives in the dialog, which owns the inline error slot the failures
// belong in.
//
// Self-contained, so App lends `describeSelected` a `HandlerMap` slot and
// nothing else — the same split `commands/silenceCommands.ts` documents, and
// for the same reason: a command registered by Timeline vanishes with the
// Timeline Panel, and the clip context menu must not lose rows when a Panel is
// closed (`menu/contextMenuCommands.test.ts` states the rule).

import { openDescribePrompt } from "../describe/describePrompt";
import {
  canDescribeSelection,
  describeTarget,
} from "../describe/describeEligibility";
import i18n from "../i18n";
import { layerDisplayName } from "../lib/layerName";

export { canDescribeSelection };

/// Raise the describe dialog for the primary selected clip.
///
/// The selection is read from the store, not from a captured value: the gate is
/// evaluated live for the same reason, and App does not re-render on a
/// multi-select change.
///
/// The name is resolved HERE and carried into the dialog, off `i18n.t` rather
/// than a component's `useTranslation` — the command runs where there is no
/// React. No group ordinals are passed because a Group layer never reaches this
/// point: the gate admits VideoClip alone, which is also why reading `media_id`
/// off that view is exhaustive.
export function openDescribeForSelection(): void {
  const layer = describeTarget();
  // Prevented by the command's `enabled`; a palette entry built before the
  // selection changed can still reach here, and doing nothing is the honest
  // answer to "no target".
  if (!layer) return;
  const params = layer.params;
  if (params.kind !== "VideoClip") return;
  openDescribePrompt({
    layerId: layer.id,
    layerName: layerDisplayName(layer, (key, values) => i18n.t(key, values)),
    mediaId: params.media_id,
  });
}
