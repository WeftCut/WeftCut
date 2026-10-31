// Describing ONE shot, and describing a whole reviewed list of them.
//
// Why a shot is a better unit than a clip. `describe_clip` samples the window it
// is given and lets the model choose where its own segments begin, so a
// whole-clip run at 1 fps answers with spans that straddle the boundaries the
// detector found — which is informative (`segmentsForSpan` exists to show that
// disagreement) and is not what a reviewer reading a shot list wants. Handed a
// single shot's window, the model has nowhere else to put a boundary: the prose
// is about that shot and lands on that row.
//
// Which is also why this needs no new tool. `describe_clip` already takes
// `t_start_us` / `t_end_us` and validates them against the layer; each shot run
// carries the `shot` purpose, so N shot-sized runs accumulate apart from the
// whole-clip description, and the rows read them back through
// `media://{id}/shot-description`.
//
// Lives in `describe/` beside `segmentsForSpan.ts`, which owns the other half of
// the same join, and takes a plain span rather than a `ShotRow`: what a run
// needs is a window and an ordinal to name it by, not the reviewer's checkboxes.

import i18n from "../i18n";
import {
  setDescribeBatch,
  useDescriptionsStore,
} from "./descriptionsStore";
import { runDescribe } from "./describeRun";

/// One shot to describe: the span in both clocks, and the ordinal it is called
/// by. `index` is 0-based, as `ShotRow.index` is; the label says `index + 1`.
export interface DescribableShot {
  index: number;
  /// Source time — the domain the answer is merged over and the rows are keyed
  /// in.
  srcStartUs: number;
  srcEndUs: number;
  /// Timeline time — the domain `describe_clip`'s window arguments are in.
  tStartUs: number;
  tEndUs: number;
}

/// The clip the shots belong to.
export interface DescribeShotsSubject {
  layerId: string;
  mediaId: string;
  clipName: string;
}

/// A sweep asked to stop. Module scope rather than store state: nothing renders
/// off it — the button's affordance comes from `batch !== null` — and a request
/// that outlived one sweep would silently kill the next one's first shot.
let cancelRequested = false;

/// Ask the running sweep to stop after the shot it is on.
///
/// AFTER and not during: Stop ends the sweep, not the job in flight —
/// abandoning the promise would leave the engine running and the row it answers
/// for blank. So the sweep finishes the shot it started, keeps that prose, and
/// stops. (Cancelling the job itself, e.g. from its compute band, also ends the
/// sweep.) That is also the honest reading
/// of the button: a sweep of local model runs needs a way out, and the way out
/// costs at most one more run.
export function cancelDescribeShots(): void {
  if (useDescriptionsStore.getState().batch !== null) cancelRequested = true;
}

/// What the log rows call one shot's run. Off `i18n.t` rather than a component's
/// `useTranslation` — a sweep runs where there is no React, the way
/// `describeCommands.ts` resolves its clip name.
function shotLabel(clipName: string, index: number): string {
  return i18n.t("shots_panel.describe_shot_subject", {
    clip: clipName,
    index: index + 1,
  });
}

/// Describe the given shots, one at a time, in the order they were handed over.
///
/// SERIAL, and that is the whole reason this is a function rather than a
/// `Promise.all`: the engine is a local 2.5 GB model, so two spawns contend for
/// the same VRAM and finish no sooner than one after the other — and thirty
/// would simply thrash. `runDescribe` refuses to start while another run is
/// going anyway, so a parallel version would silently drop most of the list.
///
/// STOPS on the first failure. The failures this path has are properties of the
/// setup rather than of a shot — no engine configured, a missing model file —
/// so run two of thirty would fail for the same reason as run one, and the
/// reviewer would have to read the same sentence thirty times to find out. The prose already landed stays; the sentence is in the store's slot.
///
/// The caller decides WHICH shots: the Panel passes the rows that have nothing
/// yet, because that is the count its button has to name.
export async function describeShotRows(
  shots: readonly DescribableShot[],
  subject: DescribeShotsSubject,
): Promise<void> {
  if (shots.length === 0) return;
  if (useDescriptionsStore.getState().batch !== null) return;
  cancelRequested = false;
  try {
    // The counter is published from INSIDE the loop and nowhere else, so there
    // is one statement of what `done` means. The list is non-empty by the guard
    // above, and every statement up to the first `await` is synchronous, so the
    // button has flipped to Stop before any run can be seen to start.
    for (const [done, shot] of shots.entries()) {
      if (cancelRequested) break;
      setDescribeBatch({ done, total: shots.length });
      // A cancelled job (ADR 0121) stops the sweep as its Stop button does.
      const message = await describeOneShot(shot, subject, () => { cancelRequested = true; });
      if (message !== "") break;
    }
  } finally {
    setDescribeBatch(null);
    cancelRequested = false;
  }
}

/// One shot, one run — what a row's own button presses and what the sweep loops
/// over. Answers the failure's sentence, or `""`.
///
/// States no view parameters, and needs none: sampling, focus and language come
/// from the user's Settings → Video understanding through main's injection, so
/// each shot run uses the view `media://{id}/shot-description` reads back.
/// Its explicit purpose keeps it separate from whole-clip descriptions even
/// when the source window and every model setting are identical.
export async function describeOneShot(
  shot: DescribableShot,
  subject: DescribeShotsSubject,
  onCancelled?: () => void,
): Promise<string> {
  return runDescribe({
    purpose: "shot",
    ...(onCancelled ? { onCancelled } : {}),
    layerId: subject.layerId,
    mediaId: subject.mediaId,
    srcStartUs: shot.srcStartUs,
    srcEndUs: shot.srcEndUs,
    // The window in TIMELINE time, which is the domain `describe_clip` validates
    // against the layer. A merged row's span is its parts concatenated, so this
    // is one window over several detected shots — exactly the span the reviewer
    // decided is one shot, which is the only span whose prose would mean
    // anything on that row.
    window: { tStartUs: shot.tStartUs, tEndUs: shot.tEndUs },
    label: shotLabel(subject.clipName, shot.index),
  });
}
