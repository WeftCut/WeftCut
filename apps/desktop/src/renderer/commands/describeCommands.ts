// The describe gesture as a command: ask a vision model what is in one clip.
//
// It RUNS. The two parameters a dialog used to offer are the user's Settings →
// Video understanding now, so there is nothing left to ask before starting —
// which is why the menu label carries no ellipsis.
//
// App lends the Settings remedy. Progress and cancellation live on the clip's
// timeline task band; this command has no dependency on the Shots Panel.
//
// Self-contained, so App lends `describeSelected` a `HandlerMap` slot and
// nothing else — the same split `commands/pauseCommands.ts` documents, and
// for the same reason: a command registered by Timeline vanishes with the
// Timeline Panel, and the clip context menu must not lose rows when a Panel is
// closed (`menu/contextMenuCommands.test.ts` states the rule).

import {
  canDescribeSelection,
  describeTarget,
} from "../describe/describeEligibility";
import { runDescribe } from "../describe/describeRun";
import i18n from "../i18n";
import { layerDisplayName } from "../lib/layerName";

export { canDescribeSelection };

/// Rust's refusal when nothing is configured to describe with — the ONE failure
/// with a remedy inside the app, which is why it is the one that gets acted on
/// rather than only logged. Every other refusal (an unavailable explicit engine,
/// a missing endpoint URL) already names what to go and do, and
/// the status log carries it verbatim.
///
/// Matched on the leading phrase rather than the whole sentence: the tool's
/// version ends by naming the two ways to configure one, and it crosses IPC
/// inside Electron's own prose (`errors/tryMutate.ts` documents that wrapping),
/// so anything anchored at either end would break. A prose refusal, so there is
/// no structured code to match on instead.
function isNoBackendConfigured(message: string): boolean {
  return /no video-understanding backend/.test(message);
}

/// Describe the primary selected clip, start to finish.
///
/// The timeline task band and status log show the run; it does not open or
/// publish progress to the Shots Panel.
///
/// The selection is read from the store, not from a captured value: the gate is
/// evaluated live for the same reason, and App does not re-render on a
/// multi-select change.
///
/// The name is resolved HERE and carried into the run, off `i18n.t` rather than
/// a component's `useTranslation` — the command runs where there is no React. No
/// group ordinals are passed because a Group layer never reaches this point: the
/// gate admits VideoClip alone, which is also why reading `media_id` off that
/// view is exhaustive.
export async function describeSelected(deps: {
  openSettings: () => void;
}): Promise<void> {
  const layer = describeTarget();
  // Prevented by the command's `enabled`; a palette entry built before the
  // selection changed can still reach here, and doing nothing is the honest
  // answer to "no target".
  if (!layer) return;
  const params = layer.params;
  if (params.kind !== "VideoClip") return;
  const message = await runDescribe({
    purpose: "clip",
    layerId: layer.id,
    mediaId: params.media_id,
    // The clip's whole source window: no window arguments go on the wire, so
    // Rust answers for exactly this span, and this is the span the answer is
    // merged over. Read off the layer rather than recomputed from a duration —
    // a trimmed clip's source window is not its length from zero.
    srcStartUs: params.src_in_us,
    srcEndUs: params.src_out_us,
    // No window at all, so Rust's own endpoints decide. A human who wants a
    // shorter one describes a SHOT from the Shots Panel, which is the same tool
    // over the boundaries the detector already found.
    window: null,
    label: layerDisplayName(layer, (key, values) => i18n.t(key, values)),
  });
  // The failure's own sentence is already in the status log (`runDescribe` puts
  // it there). What this surface adds is the one thing a log row cannot carry:
  // the remedy itself. OPENED rather than offered — the panel it opens is where
  // the missing engine gets configured, and the user just asked for the thing
  // that needs one.
  if (message !== "" && isNoBackendConfigured(message)) deps.openSettings();
}
