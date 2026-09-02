// The silence gesture as a command: find one clip's silent stretches.
//
// Only RAISES a dialog — the parameters come from the authored `cut-silences`
// MCP prompt (`native/src/mcp/prompts.rs`), and the recipe is not complete
// without them. The work itself lives in the dialog, which owns the live preview
// and the inline error slot the failures belong in.
//
// Self-contained, so App lends `detectSilencesSelected` a `HandlerMap` slot and
// nothing else — the same split `commands/speechCommands.ts` documents, and for
// the same reason: a command registered by Timeline vanishes with the Timeline
// Panel, and the clip context menu must not lose rows when a Panel is closed
// (`menu/contextMenuCommands.test.ts` states the rule).

import i18n from "../i18n";
import { layerDisplayName } from "../lib/layerName";
import {
  audioClipTarget,
  canTargetAudioClip,
} from "../speech/autoCaptionEligibility";
import { openSilencePrompt } from "../silence/silencePrompt";

/// The gate is the shared audio-clip one, not a copy of it: a clip with no
/// audio has no silence to find, and a re-timed one would have its ranges
/// marked at times its audio never reaches (`audioClipState` states both).
///
/// Auto-caption's extra "a transcription is already running" condition is NOT
/// folded in, and deliberately: marking silences is a local commit that starts
/// nowhere but its own dialog, so greying this row for a network call it shares
/// nothing with would be a refusal with no instruction behind it.
export { canTargetAudioClip as canDetectSilencesSelection };

/// Raise the silence dialog for the primary selected clip.
///
/// The selection is read from the store, not from a captured value: the gate is
/// evaluated live for the same reason, and App does not re-render on a
/// multi-select change.
///
/// The name is resolved HERE and carried into the dialog, off `i18n.t` rather
/// than a component's `useTranslation` — the command runs where there is no
/// React. No group ordinals are passed because a Group layer never reaches this
/// point: the gate admits VideoClip and Audio only, which is also why reading
/// `media_id` off those two views is exhaustive.
export function openSilenceForSelection(): void {
  const layer = audioClipTarget();
  // Prevented by the command's `enabled`; a palette entry built before the
  // selection changed can still reach here, and doing nothing is the honest
  // answer to "no target".
  if (!layer) return;
  const params = layer.params;
  if (params.kind !== "VideoClip" && params.kind !== "Audio") return;
  openSilencePrompt({
    layerId: layer.id,
    layerName: layerDisplayName(layer, (key, values) => i18n.t(key, values)),
    mediaId: params.media_id,
  });
}
