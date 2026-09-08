// One description run, from the press to the prose on the rows — the whole of
// it, so the dialog and the Shots Panel's buttons are literally the same run.
//
// Extracted the day the Panel grew a per-shot button. Duplicating this in the
// Panel would have meant two statements of the log pair, two of the in-flight
// flag, two of the optimistic-fill rule and two of what a default view is; the
// last one matters most, because a run at a NON-default view lands somewhere
// `media://{id}/description` cannot read it back from, and a second copy of that
// rule would be free to drift into producing prose nobody can find again.
//
// Deliberately NOT in `descriptionsStore.ts`: that module's stated rule is that
// reading a description never computes one, and a `describeClip` call inside it
// would be exactly the shape that rule forbids. The store holds the answers;
// this is the one thing allowed to spend a model to get one.

import { logMutationFailure, refusalText } from "../errors/tryMutate";
import { describeClip, logEmit, type DescribeFocus } from "../ipc";
import {
  mergeDescription,
  reloadDescription,
  setDescribeError,
  setDescribing,
  useDescriptionsStore,
} from "./descriptionsStore";

/// The parameter values `describe_clip` resolves an omitted argument to.
///
/// TWIN of `DescribeClipArgs`' `unwrap_or(1.0)`, `Focus::parse(None)` and
/// `Language::parse(None)` (`native/src/mcp/tools.rs`,
/// `native/src/vlm/describer.rs`), and knowingly so — the addon exposes no
/// getter for them the way it does for the shot detector's (`shot_default_opts`).
/// Change one side and change this one: these values are also the key of the
/// DEFAULT view, the only one `media://{id}/description` serves, so a mismatch
/// here would produce descriptions the shot rows can never read back.
export const DEFAULT_FPS = 1.0;
export const DEFAULT_FOCUS: DescribeFocus = "general";

/// `language` is absent from that pair on purpose. The default is the app's UI
/// language, and the renderer never states it: Electron main injects it into
/// `describe_clip` AND into the resource read from ONE value
/// (`main/index.ts` `getVlm`), which is the only arrangement under which the
/// view a run writes and the view the rows read cannot disagree. A renderer that
/// sent a language of its own would be a second opinion about the same question.
///
/// Which is also why a run is at the default VIEW whenever its two parameters
/// are default: language is not a parameter this surface offers.
export function isDefaultView(fps: number, focus: DescribeFocus): boolean {
  return fps === DEFAULT_FPS && focus === DEFAULT_FOCUS;
}

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
  /// What the log rows and the dialog call this run's subject: the clip's name,
  /// or the clip's name and the shot's ordinal.
  label: string;
}

/// Run one description and land it. Answers the failure's own sentence, or `""`
/// on success — the dialog needs it for its inline slot, and the Panel's buttons
/// let it go to the store's slot instead.
///
/// Refuses to start while another run is going. The engine is a local model:
/// two spawns would halve each other's speed, and the batch arm below is exactly
/// the surface that would otherwise fire thirty at once.
export async function runDescribe(
  target: DescribeRunTarget,
  opts: { fps?: number; focus?: DescribeFocus } = {},
): Promise<string> {
  if (useDescriptionsStore.getState().describing !== null) return "";
  const fps = opts.fps ?? DEFAULT_FPS;
  const focus = opts.focus ?? DEFAULT_FOCUS;
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
    // Omitted at the defaults so Rust's own decide (`ipc/index.ts` states the
    // rule) — which is also what keeps a default run landing in the view the
    // shot rows read back.
    const result = await describeClip({
      layerId: target.layerId,
      ...(target.window === null
        ? {}
        : { tStartUs: target.window.tStartUs, tEndUs: target.window.tEndUs }),
      ...(fps === DEFAULT_FPS ? {} : { fps }),
      ...(focus === DEFAULT_FOCUS ? {} : { focus }),
    });
    setDescribing(null);
    // The run's own segments first, over its own window and nothing wider, so
    // the cells it answered for fill the moment the model is done. Then, at the
    // default view only, the cache behind them: it holds every window of this
    // source ever described, so the re-read is how a row picks up prose an
    // earlier run on a neighbouring shot produced. A finer or re-focused run has
    // no such view to re-read, and asking for one would answer with the default
    // view's segments — over the top of the ones just computed.
    mergeDescription(mediaId, srcStartUs, srcEndUs, result.segments);
    if (isDefaultView(fps, focus)) void reloadDescription(mediaId);
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
