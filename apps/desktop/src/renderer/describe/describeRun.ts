// One description run, from the press to the prose on the rows — the whole of
// it, so the describe command and the Shots Panel's buttons are literally the
// same run.
//
// Duplicating this in the Panel would have meant two statements of the log pair,
// two of the in-flight flag and two of the optimistic-fill rule.
//
// It states NO run parameters. Sampling, focus and language are the user's
// Settings → Video understanding, and Electron main injects all three into
// `describe_clip` and into the `media://{id}/description` read from one provider
// (`main/index.ts` `getVlm`) — the only arrangement under which the view a run
// writes and the view the rows read cannot disagree. A default restated here
// would be a second opinion about a setting this surface does not own.
//
// Deliberately NOT in `descriptionsStore.ts`: that module's stated rule is that
// reading a description never computes one, and a `describeClip` call inside it
// would be exactly the shape that rule forbids. The store holds the answers;
// this is the one thing allowed to spend a model to get one.

import { logMutationFailure, refusalText } from "../errors/tryMutate";
import { describeClip, logEmit } from "../ipc";
import {
  mergeDescription,
  reloadDescription,
  setDescribeError,
  setDescribing,
  useDescriptionsStore,
} from "./descriptionsStore";

/// What to describe, and what to call it in the log.
export interface DescribeRunTarget {
  layerId: string;
  mediaId: string;
  /// The span the run answers for, in SOURCE time — the domain the cache and the
  /// rows share, and what the optimistic fill is merged over.
  srcStartUs: number;
  srcEndUs: number;
  /// The same span in TIMELINE time, or null for the whole layer.
  ///
  /// Null is not "no window": it is the instruction to OMIT the two window
  /// arguments so Rust's own endpoints decide, on `ipc/index.ts`' rule. A
  /// whole-clip run must send no window at all — sending the layer's own
  /// endpoints would be a second statement of a default that already has one.
  window: { tStartUs: number; tEndUs: number } | null;
  /// What the log rows call this run's subject: the clip's name, or the clip's
  /// name and the shot's ordinal.
  label: string;
}

/// Run one description and land it. Answers the failure's own sentence, or `""`
/// on success — the command needs it to decide whether the failure has a remedy
/// to open, and the Panel's buttons let it go to the store's slot instead.
///
/// Refuses to start while another run is going. The engine is a local model:
/// two spawns would halve each other's speed, and the batch arm below is exactly
/// the surface that would otherwise fire thirty at once.
export async function runDescribe(target: DescribeRunTarget): Promise<string> {
  if (useDescriptionsStore.getState().describing !== null) return "";
  const { mediaId, srcStartUs, srcEndUs } = target;

  setDescribeError("");
  setDescribing({ mediaId, srcStartUs, srcEndUs });
  // Twenty seconds against a local model, so the run announces itself: without
  // a Started row the status badge has nothing to spin on and the user cannot
  // tell a slow engine from a dead one. One `op_id` pairs it with the terminal
  // row (docs/status-log.md).
  const opId = crypto.randomUUID();
  void logEmit({
    level: "info",
    category: { kind: "Project" },
    source: { kind: "User" },
    message: `Describing ${target.label}`,
    i18n_key: "log.describe_started",
    i18n_args: { clip: target.label },
    op_id: opId,
    op_state: { state: "Started" },
  });
  try {
    // The window is the only argument this layer states. The three view axes are
    // main's to fill (`ipc/index.ts` `describeClip` states the rule).
    const result = await describeClip({
      layerId: target.layerId,
      ...(target.window === null
        ? {}
        : { tStartUs: target.window.tStartUs, tEndUs: target.window.tEndUs }),
    });
    setDescribing(null);
    // The run's own segments first, over its own window and nothing wider, so
    // the cells it answered for fill the moment the model is done. Then the cache
    // behind them: it holds every window of this source described under the
    // current view, so the re-read is how a row picks up prose an earlier run on
    // a neighbouring shot produced.
    //
    // UNCONDITIONAL, and that is the whole point of injecting the view: the read
    // resolves the same key the run just wrote, so there is no longer a setting
    // at which the re-read would answer with some other view's segments over the
    // top of the ones just computed.
    mergeDescription(mediaId, srcStartUs, srcEndUs, result.segments);
    void reloadDescription(mediaId);
    void logEmit({
      level: "info",
      category: { kind: "Project" },
      source: { kind: "User" },
      message: `${result.segments.length} described spans in ${target.label} (${result.backend}, ${result.model})`,
      i18n_key: "log.describe_done",
      i18n_args: {
        clip: target.label,
        segments: result.segments.length,
        engine: result.backend,
        model: result.model,
      },
      op_id: opId,
      op_state: { state: "Ok" },
    });
    return "";
  } catch (err) {
    // The tool's own message, verbatim: "no backend available" names the two
    // ways to configure one, an explicit engine names the path it is missing,
    // and a speed refusal names the split to make. A generic "description
    // failed" would throw away the only actionable half.
    const message = refusalText(err);
    setDescribeError(message);
    setDescribing(null);
    // Under the run's own `op_id`, or the Started row above never closes and the
    // status bar keeps a description spinning that has already failed.
    logMutationFailure(err, "describe_clip", opId);
    return message;
  }
}
