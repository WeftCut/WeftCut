// The two speech gestures as commands: transcribe a clip, and speak a script.
//
// They differ in shape, and the difference is what each one still has to ask.
// Transcription RUNS: its parameters are the clip, which is the selection, and
// a language hint every engine detects for itself, so there is nothing left to
// ask before starting and the menu label carries no ellipsis
// (`speech/transcribeRun.ts` says why the hint was never worth a field).
// Voiceover only RAISES a dialog — a script is not something a selection can
// supply, so the authored recipe (`native/src/mcp/prompts.rs`) is not complete
// without asking, and the dialog owns the inline error slot its failures
// belong in.
//
// Self-contained, so App lends `autoCaptionSelected` a `HandlerMap` slot and
// the two things only App can do — the same split `commands/describeCommands.ts`
// documents. That is what puts them in App's catalogue rather than Timeline's
// provider: a command registered by Timeline vanishes with the Timeline Panel,
// and the clip context menu must not lose rows when a Panel is closed
// (`menu/contextMenuCommands.test.ts` states the rule).

import i18n from "../i18n";
import { layerDisplayName } from "../lib/layerName";
import {
  canAutoCaptionSelection,
  transcribeTargets,
} from "../speech/autoCaptionEligibility";
import { runTranscribe } from "../speech/transcribeRun";
import { openVoiceoverPrompt } from "../speech/voiceoverPrompt";

export { canAutoCaptionSelection };

/// Rust's refusals that end by naming the Transcription pane — no model
/// prepared, no API key for the chosen provider — are the failures with a remedy
/// INSIDE the app, which is why they are the ones acted on rather than only
/// logged. Every other refusal (the payload cap, a re-timed clip) already names
/// what to go and do, and the status log carries it verbatim.
///
/// Matched on the remedy phrase itself rather than on either sentence's opening:
/// two refusals end this way today, both cross IPC inside Electron's own prose
/// (`errors/tryMutate.ts` documents that wrapping), and a third that grows the
/// same ending gets the same door opened without a change here. Prose refusals,
/// so there is no structured code to match on instead.
function namesTranscriptionSettings(message: string): boolean {
  return /Settings → Transcription/.test(message);
}

/// Transcribe the selected clips, start to finish — every clip with sound in
/// the selection, reduced to one subject per source (`transcribeSubjects`
/// states the rule), read in timeline order and landed as ONE commit.
///
/// The selection is read from the store, not from a captured value: the gate is
/// evaluated live for the same reason, and App does not re-render on a
/// multi-select change.
///
/// The names are resolved HERE and carried into the run, off `i18n.t` rather
/// than a component's `useTranslation` — the command runs where there is no
/// React. No group ordinals are passed because a Group layer never reaches this
/// point: the subjects are VideoClip and Audio layers only.
export async function transcribeSelected(deps: {
  revealCaptions: () => void;
  openSettings: () => void;
}): Promise<void> {
  const clips = transcribeTargets();
  // Prevented by the command's `enabled`; a palette entry built before the
  // selection changed can still reach here, and doing nothing is the honest
  // answer to "no target".
  if (clips.length === 0) return;
  const t = (key: string, values: Record<string, unknown>) => i18n.t(key, values);
  const message = await runTranscribe({
    clips: clips.map((layer) => ({ layerId: layer.id, label: layerDisplayName(layer, t) })),
    revealCaptions: deps.revealCaptions,
  });
  // The failure's own sentence is already in the status log (`runTranscribe`
  // puts it there). What this surface adds is the one thing a log row cannot
  // carry: the remedy itself. OPENED rather than offered — the pane it opens is
  // where the missing engine or key gets configured, and the user just asked
  // for the thing that needs one.
  if (message !== "" && namesTranscriptionSettings(message)) deps.openSettings();
}

export { openVoiceoverPrompt };
