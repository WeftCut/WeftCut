// The two speech gestures as commands: caption a clip, and speak a script.
//
// Both only RAISE a dialog — the parameters come from the authored MCP prompts
// (`native/src/mcp/prompts.rs`), and neither recipe is complete without them.
// The work itself lives in the dialogs, which own the inline error slot the
// failures belong in.
//
// Self-contained, so App lends `autoCaptionSelected` a `HandlerMap` slot and
// nothing else — the same split `commands/groupCommands.ts` documents. That is
// what puts them in App's catalogue rather than Timeline's provider: a command
// registered by Timeline vanishes with the Timeline Panel, and the clip context
// menu must not lose rows when a Panel is closed
// (`menu/contextMenuCommands.test.ts` states the rule).

import i18n from "../i18n";
import { layerDisplayName } from "../lib/layerName";
import {
  audioClipTarget,
  canAutoCaptionSelection,
} from "../speech/autoCaptionEligibility";
import { openAutoCaptionPrompt } from "../speech/autoCaptionPrompt";
import { openVoiceoverPrompt } from "../speech/voiceoverPrompt";

export { canAutoCaptionSelection };

/// Raise the auto-caption dialog for the primary selected clip.
///
/// The selection is read from the store, not from a captured value: the gate is
/// evaluated live for the same reason, and App does not re-render on a
/// multi-select change.
///
/// The name is resolved HERE and carried into the dialog, off `i18n.t` rather
/// than a component's `useTranslation` — the command runs where there is no
/// React. No group ordinals are passed because a Group layer never reaches this
/// point: the gate admits VideoClip and Audio only.
export function openAutoCaptionForSelection(): void {
  const layer = audioClipTarget();
  // Prevented by the command's `enabled`; a palette entry built before the
  // selection changed can still reach here, and doing nothing is the honest
  // answer to "no target".
  if (!layer) return;
  openAutoCaptionPrompt(
    layer.id,
    layerDisplayName(layer, (key, values) => i18n.t(key, values)),
  );
}

export { openVoiceoverPrompt };
