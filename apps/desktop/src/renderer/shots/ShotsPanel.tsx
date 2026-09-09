// The Shots Panel: the review surface for detected shot boundaries — one row
// per shot, each carrying its cover frame, its opening candidate's score and
// frame pair, its stats and flags, and the two checkboxes the reviewer decides
// with.
//
// Why shots get a Panel and the other analysis capabilities do not: what earns
// a review surface is whether checking one result costs less than undoing all
// of them. A shot cut is verified by looking at one frame pair, and the detector
// really does misfire — so review pays. Silence has to be listened to and a
// transcript has to be read (and then edited), which is why neither gets one.
//
// The Panel follows the primary selected VideoClip and NEVER scans on selection:
// clicking clips is the highest-frequency gesture in the app, and the floor scan
// is a whole-source decode. `shotsStore.ts` is where that rule is enforced.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { AppCheckbox } from "../components/AppCheckbox";
import { AppNumberField } from "../components/AppNumberField";
import { formatMediaDuration, formatTimecode } from "../frames";
import {
  getMediaFrame,
  type CompositionSummary,
  type LayerSummary,
  type ShotFlag,
  type TrackSummary,
} from "../ipc";
import { useDescribeState, type DescribeState } from "../describe/describeEligibility";
import {
  cancelDescribeShots,
  describeOneShot,
  describeShotRows,
} from "../describe/describeShots";
import {
  hydrateDescription,
  isDescribingSpan,
  setDescribeError,
  useDescribeBatch,
  useDescribeError,
  useDescribing,
  useDescription,
  type DescribingSpan,
} from "../describe/descriptionsStore";
import { segmentsForSpan } from "../describe/segmentsForSpan";
import { layerDisplayName } from "../lib/layerName";
import {
  focusedCompositionId,
  openComposition,
  useCompositionAnchorStore,
} from "../state/compositionAnchorStore";
import { jumpToTimeUs } from "../state/navigation";
import { focusedRootUs } from "../state/playheadProjection";
import {
  compositionOrRoot,
  useGroupOrdinals,
  useProjectStore,
} from "../state/projectStore";
import { usePrimaryLayerId } from "../state/selectionStore";
import { primarySelectedLayer } from "../speech/autoCaptionEligibility";
import { ScoreStrip } from "./ScoreStrip";
import { shotRows, type ShotCandidate, type ShotRow } from "./shotRows";
import {
  analyzeShotSubject,
  applyShotVerb,
  commitShotThreshold,
  loadShotDefaults,
  measureShotRows,
  resetShotsStore,
  setCandidateAccepted,
  setRowKept,
  setShotMinShotUs,
  setShotSubject,
  setShotThreshold,
  shotApplyBlocker,
  useDiscardedRows,
  useShotAnalyzing,
  useShotApplying,
  useShotCached,
  useShotError,
  useShotFloor,
  useShotFloorReport,
  useShotMeasuring,
  useShotMinShotUs,
  useShotReduced,
  useShotThreshold,
  useSpanStats,
  useVetoedCandidates,
  wireShotReviewPrefs,
  type ShotApplyVerb,
} from "./shotsStore";

/// Stable empty reference — a fresh `[]` per selector call would defeat the
/// reference-equality bail-out the subject hooks rely on.
const NO_TRACKS: readonly TrackSummary[] = [];

/// How many cover / pair frames may be in flight at once. Each one is an ffmpeg
/// extract on a cold cache, so an unbounded burst on a 40-shot clip would
/// contend with the preview's own decoding for the whole first paint.
const FRAME_CONCURRENCY = 3;

/// Frames already fetched this session, keyed `mediaId@tUs`. Main caches the
/// extraction per `(source, t)` too, but a re-render should not spend an IPC
/// round trip to learn what it already has on screen.
const frameCache = new Map<string, string>();

let inFlight = 0;
const frameQueue: (() => void)[] = [];

/// Bumped by `resetFrameLoader`. An extract that was in flight across a reset
/// keeps running — there is no way to cancel it — but it no longer returns a
/// slot to the pool, because that pool was already emptied. Without the
/// generation check its late `finally` would push `inFlight` negative and let
/// the cap drift open.
let frameGeneration = 0;

function pumpFrameQueue(): void {
  while (inFlight < FRAME_CONCURRENCY) {
    const next = frameQueue.shift();
    if (!next) return;
    inFlight += 1;
    next();
  }
}

/// Drop everything the loader holds. Called when the Panel unmounts, alongside
/// the store's own reset and for the same reason: the cache is keyed by media
/// id, and a relink points that id at different footage. It also abandons the
/// queue, so a Panel closed mid-load does not leave the cap held by frames
/// nobody will look at again.
function resetFrameLoader(): void {
  frameGeneration += 1;
  frameQueue.length = 0;
  inFlight = 0;
  frameCache.clear();
}

/// One frame of a source as a `data:` URL, fetched lazily behind the
/// concurrency cap.
///
/// Loaded on mount rather than on intersection: `IntersectionObserver` does not
/// exist in jsdom, so an observer path would be the one path no test covers,
/// and a clip's shot count is bounded small enough that the cap alone keeps the
/// burst civil.
function useMediaFrameUrl(
  mediaId: string,
  tUs: number | null,
): { url: string | null; failed: boolean } {
  const key = tUs === null ? null : `${mediaId}@${tUs}`;
  const [url, setUrl] = useState<string | null>(() =>
    key === null ? null : frameCache.get(key) ?? null,
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (key === null || tUs === null) return;
    const cached = frameCache.get(key);
    if (cached !== undefined) {
      setUrl(cached);
      setFailed(false);
      return;
    }
    setUrl(null);
    setFailed(false);
    let live = true;
    const start = () => {
      const generation = frameGeneration;
      void getMediaFrame(mediaId, tUs)
        .then((dataUrl) => {
          frameCache.set(key, dataUrl);
          if (live) setUrl(dataUrl);
        })
        .catch(() => {
          // A frame is illustration, not data: a source mid-import or a seek
          // the extractor refuses leaves the placeholder standing, and nothing
          // about the row's spans is affected.
          if (live) setFailed(true);
        })
        .finally(() => {
          if (generation !== frameGeneration) return;
          inFlight -= 1;
          pumpFrameQueue();
        });
    };
    frameQueue.push(start);
    pumpFrameQueue();
    return () => {
      live = false;
      // Dropping the queued starter matters more than the in-flight one: a
      // fast scroll through a long list would otherwise hold the cap on frames
      // nobody is looking at any more.
      const queued = frameQueue.indexOf(start);
      if (queued !== -1) frameQueue.splice(queued, 1);
    };
  }, [key, mediaId, tUs]);
  return { url, failed };
}

/// A frame slot that always occupies its space. The fixed aspect ratio is what
/// keeps a pending or failed frame from collapsing the row and reflowing every
/// row below it while the extracts land one by one.
function ShotFrame({
  mediaId,
  tUs,
  alt,
  className,
}: {
  mediaId: string;
  tUs: number | null;
  alt: string;
  className: string;
}) {
  const { url, failed } = useMediaFrameUrl(mediaId, tUs);
  return (
    <div className={className} data-state={url ? "loaded" : failed ? "failed" : "pending"}>
      {url !== null && <img src={url} alt={alt} draggable={false} />}
    </div>
  );
}

/// The three stats, or the absent marker. A row nothing has measured yet — the
/// floor scan is timing-only, so at first that is every row — reads as absent,
/// because `0` would report a black, motionless, out-of-focus shot that was
/// simply never sampled. *Measure shots* is what fills them.
function ShotStatsCells({ row }: { row: ShotRow }) {
  const { t } = useTranslation();
  if (row.stats === null) {
    return (
      <span className="shots-stats shots-stats-absent">
        {t("shots_panel.stats_absent")}
      </span>
    );
  }
  const { brightness, motion, sharpness } = row.stats;
  return (
    <span className="shots-stats">
      <span title={t("shots_panel.brightness")}>
        {t("shots_panel.brightness_value", { value: brightness.toFixed(2) })}
      </span>
      <span title={t("shots_panel.motion")}>
        {t("shots_panel.motion_value", { value: motion.toFixed(2) })}
      </span>
      <span title={t("shots_panel.sharpness")}>
        {t("shots_panel.sharpness_value", { value: sharpness.toFixed(3) })}
      </span>
    </span>
  );
}

/// What a vision model said about this shot's stretch of the source, plus the
/// tags it extracted.
///
/// The join is a time intersection and nothing else: `describe_clip` segments
/// and shot spans are both source-absolute (`describe/segmentsForSpan.ts`). A
/// segment that straddles two boundaries shows on BOTH rows — the model and the
/// detector disagreeing about where the content changes is the correlation this
/// column exists to make visible.
///
/// "Not described" and never blank: shots without descriptions are the normal
/// case, and an empty cell would read as a load that never finished. The one
/// transient is a run whose window OVERLAPS this row, which the cell may say it
/// is waiting on — but only where it has nothing else to show, so a re-describe
/// never blanks prose that is already on screen.
///
/// The transient is span-scoped and not source-scoped, because a run is now as
/// often about one shot as about a whole clip: a per-shot press must not report
/// work on the twenty-nine rows it is not going to answer for.
///
/// Read-only. Editing a model's sentences is not a feature this column claims —
/// but asking for them IS, which is the button beside it.
function ShotDescriptionCell({
  row,
  mediaId,
  describeBlocker,
  onDescribe,
}: {
  row: ShotRow;
  mediaId: string;
  /// Why this row cannot be described, as a `shots_panel.*` key, or null.
  describeBlocker: string | null;
  onDescribe: (row: ShotRow) => void;
}) {
  const { t } = useTranslation();
  const segments = useDescription(mediaId);
  const describing = useDescribing();
  const overlapping = useMemo(
    () => segmentsForSpan(segments, row.srcStartUs, row.srcEndUs),
    [segments, row.srcStartUs, row.srcEndUs],
  );
  const waiting = isDescribingSpan(
    describing,
    mediaId,
    row.srcStartUs,
    row.srcEndUs,
  );
  return (
    <div className="shots-description">
      {overlapping.length === 0 ? (
        <p className="shots-description-empty">
          {waiting
            ? t("shots_panel.describing")
            : t("shots_panel.not_described")}
        </p>
      ) : (
        overlapping.map((segment) => (
          <p
            className="shots-description-span"
            key={`${segment.t_start_us}-${segment.t_end_us}`}
          >
            <span className="shots-description-text">{segment.text}</span>
            {segment.tags.map((tag) => (
              <span className="shots-description-tag" key={tag}>
                {tag}
              </span>
            ))}
          </p>
        ))
      )}
      {/* One press, no dialog. The two parameters a dialog would offer are
          exactly the two that take a result OUT of the view these rows read
          back (`describeShots.ts`), so offering them on a per-row control would
          be offering a way to make the press pointless. The label says which
          gesture it is — a row with prose can still be asked again, because a
          model's answer is not a fact and re-running one is a normal thing to
          want. */}
      <Button
        className="shots-describe"
        variant="secondary"
        size="sm"
        data-testid={`shots-describe-${row.index}`}
        disabled={describeBlocker !== null}
        title={
          describeBlocker === null
            ? t("shots_panel.describe_shot_hint")
            : t(describeBlocker)
        }
        onClick={() => onDescribe(row)}
      >
        {waiting
          ? t("shots_panel.describing")
          : overlapping.length === 0
            ? t("shots_panel.describe_shot")
            : t("shots_panel.describe_shot_again")}
      </Button>
    </div>
  );
}

function ShotFlags({ flags }: { flags: readonly ShotFlag[] }) {
  const { t } = useTranslation();
  if (flags.length === 0) return null;
  return (
    <span className="shots-flags">
      {flags.map((flag) => (
        <span key={flag} className="shots-flag" data-flag={flag}>
          {t(`shots_panel.flag_${flag}`)}
        </span>
      ))}
    </span>
  );
}

/// One candidate boundary: its checkbox, its score, and the two frames either
/// side of it. Clearing the box merges the shot that opens here into its
/// predecessor; re-checking a cleared one splits the span again exactly where it
/// was.
function ShotCandidateRow({
  candidate,
  mediaId,
  accepted,
  label,
}: {
  candidate: ShotCandidate;
  mediaId: string;
  accepted: boolean;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="shots-row-header" data-accepted={accepted}>
      <AppCheckbox
        checked={accepted}
        ariaLabel={label}
        onCheckedChange={(next) =>
          setCandidateAccepted(mediaId, candidate.srcUs, next)
        }
      />
      <span className="shots-score" title={t("shots_panel.score")}>
        {candidate.score.toFixed(2)}
      </span>
      <ShotFrame
        className="shots-pair-frame"
        mediaId={mediaId}
        tUs={candidate.beforeSrcUs}
        alt={t("shots_panel.frame_before")}
      />
      <ShotFrame
        className="shots-pair-frame"
        mediaId={mediaId}
        tUs={candidate.srcUs}
        alt={t("shots_panel.frame_after")}
      />
    </div>
  );
}

/// One shot. The header is its opening candidate — score plus the frame either
/// side of the boundary — which is what makes a shot list answer the candidate
/// question too: "is this a real cut" is one look, not a second surface.
function ShotRowView({
  row,
  mediaId,
  fpsNum,
  fpsDen,
  onActivate,
  describeBlocker,
  onDescribe,
}: {
  row: ShotRow;
  mediaId: string;
  fpsNum: number;
  fpsDen: number;
  onActivate: (row: ShotRow) => void;
  describeBlocker: string | null;
  onDescribe: (row: ShotRow) => void;
}) {
  const { t } = useTranslation();
  const candidate = row.openingCandidate;
  const timecode = formatTimecode(row.tStartUs, fpsNum, fpsDen);
  return (
    <li className="shots-row" data-kept={row.keep} data-index={row.index}>
      {/* Absent on the first row and only there: the window edge is a hard
          boundary in `build_shots`, so there is no candidate to weigh — and a
          score control over nothing is a control that lies about being
          adjustable. */}
      {candidate !== null && (
        <ShotCandidateRow
          candidate={candidate}
          mediaId={mediaId}
          accepted
          label={t("shots_panel.accept_candidate", { index: row.index + 1 })}
        />
      )}
      {/* The boundaries this row swallowed, still cleared and still reversible.
          Dropping them would make a merge a one-way door. */}
      {row.mergedCandidates.map((merged) => (
        <ShotCandidateRow
          key={merged.srcUs}
          candidate={merged}
          mediaId={mediaId}
          accepted={false}
          label={t("shots_panel.restore_candidate", {
            timecode: formatTimecode(merged.srcUs, fpsNum, fpsDen),
          })}
        />
      ))}
      <div className="shots-row-body">
        <ShotFrame
          className="shots-cover"
          mediaId={mediaId}
          tUs={row.keyframeTUs}
          alt={t("shots_panel.cover_frame", { index: row.index + 1 })}
        />
        <div className="shots-row-facts">
          <button
            type="button"
            className="shots-row-goto"
            title={t("shots_panel.go_to", { timecode })}
            aria-label={t("shots_panel.go_to", { timecode })}
            onClick={() => onActivate(row)}
          >
            <span className="shots-index">{row.index + 1}</span>
            <span className="shots-timecode">{timecode}</span>
            <span className="shots-duration">
              {formatMediaDuration(row.durationUs)}
            </span>
          </button>
          <ShotStatsCells row={row} />
          <ShotFlags flags={row.flags} />
          <ShotDescriptionCell
            row={row}
            mediaId={mediaId}
            describeBlocker={describeBlocker}
            onDescribe={onDescribe}
          />
        </div>
        <AppCheckbox
          className="shots-keep"
          checked={row.keep}
          ariaLabel={t("shots_panel.keep_shot", { index: row.index + 1 })}
          onCheckedChange={(next) => setRowKept(mediaId, row.srcStartUs, next)}
        />
      </div>
    </li>
  );
}

/// The minimum-shot-length field's step, in milliseconds.
///
/// Milliseconds and not frames: `min_shot_us` is a duration in SOURCE time, and
/// the renderer does not know a source's frame rate — `MediaSummary` carries a
/// duration and dimensions and no fps at all. A frames field would have to
/// convert through the LAYER's composition rate, so the same "6 frames" would
/// mean different amounts of source on a 24p clip in a 30p timeline.
const MIN_SHOT_MS_STEP = 100;

/// The reduce refuses anything but a positive whole number of microseconds, so
/// one millisecond is the smallest length this field can offer.
const MIN_SHOT_MS_FLOOR = 1;

/// Output granularity, shaped as deliberately unlike the threshold line as
/// possible: a typed length with a unit, apart from the strip. The two fix
/// different errors — the line trades misses against false positives, while this
/// only drops boundaries closer together than itself — and two look-alike
/// sliders would invite reaching for the granularity knob to fix an accuracy
/// problem.
///
/// It shares its row with *Measure shots*, which is not an apply verb: see
/// [`MeasureShotsButton`].
function MinShotLengthField({ minShotUs }: { minShotUs: number }) {
  const { t } = useTranslation();
  const [draftMs, setDraftMs] = useState(minShotUs / 1000);
  const [editing, setEditing] = useState(false);
  // Focus-gated resync: the field mirrors what is being typed, so an echo of
  // the store landing mid-edit would clobber the digits already entered.
  useEffect(() => {
    if (!editing) setDraftMs(minShotUs / 1000);
  }, [minShotUs, editing]);
  return (
    <>
      <span className="shots-param-label">
        {t("shots_panel.min_shot_length")}
      </span>
      <AppNumberField
        className="shots-param-field"
        value={draftMs}
        min={MIN_SHOT_MS_FLOOR}
        step={MIN_SHOT_MS_STEP}
        format={{ maximumFractionDigits: 0 }}
        ariaLabel={t("shots_panel.min_shot_length")}
        onValueChange={setDraftMs}
        // One write per edit: `onCommit` fires on blur / Enter / step-end, not
        // per keystroke.
        onCommit={(ms) => void setShotMinShotUs(Math.round(ms) * 1000)}
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
      />
      <span className="shots-param-unit">{t("shots_panel.milliseconds")}</span>
    </>
  );
}

/// The on-demand stats pass, over every row that has none.
///
/// On the PARAMETERS row and deliberately not among the apply verbs: those
/// three write to the project and land an undo entry, while this writes nothing
/// but a cache sidecar — it changes what the reviewer can see, which is what the
/// threshold line and the length field do too. Filing it beside them keeps the
/// apply bar meaning exactly "commit this review".
///
/// Disabled with the reason in the tooltip, the apply buttons' convention. Three
/// preconditions, in the order that answers the reviewer's question soonest:
/// nothing left to measure, this pass already running, an apply already running
/// (the two share the inline error slot, and an apply reshapes the very rows a
/// measurement is being taken over).
function MeasureShotsButton({
  rows,
  clipName,
  applying,
}: {
  rows: readonly ShotRow[];
  clipName: string;
  applying: ShotApplyVerb | null;
}) {
  const { t } = useTranslation();
  const measuring = useShotMeasuring();
  const unmeasured = rows.filter((row) => row.stats === null).length;
  const blocker =
    unmeasured === 0
      ? "shots_panel.measure_all_measured"
      : measuring !== null
        ? "shots_panel.measure_running"
        : applying !== null
          ? "shots_panel.measure_busy"
          : null;
  return (
    <Button
      className="shots-measure"
      variant="secondary"
      size="sm"
      data-testid="shots-measure"
      disabled={blocker !== null}
      title={blocker === null ? t("shots_panel.measure_hint") : t(blocker)}
      onClick={() => void measureShotRows(rows, clipName)}
    >
      {measuring !== null
        ? t("shots_panel.measure_running")
        : t("shots_panel.measure")}
    </Button>
  );
}

/// Why a description cannot be run right now, as a `shots_panel.*` key — or null
/// when it can. ONE rule, read by every row's button AND by the sweep, so a
/// greyed row and a refused sweep can never disagree about the precondition.
///
/// `describeState` is the gate the Edit-menu command is greyed by, reused whole:
/// the Panel's subject IS the primary selection, so the same three answers apply
/// — and a re-timed clip is refused by the tool itself, which is exactly the
/// case a per-row button would otherwise offer and then always fail on.
///
/// `needs_selection` and `needs_video_kind` are deliberately not mapped: neither
/// is reachable here, because a Panel with rows has a selected VideoClip by
/// construction. They fall through to the same key the tool's own refusal would
/// name, which is honest and unreachable rather than invented copy.
export function shotDescribeBlocker(
  describe: DescribeState,
  describing: DescribingSpan | null,
  batch: { done: number; total: number } | null,
  applying: ShotApplyVerb | null,
): string | null {
  if (describe === "speed_not_one") return "shots_panel.describe_speed_not_one";
  // The shared gate's own in-flight verdict, mapped before the generic refusal
  // below — which would otherwise call a running description "not a video clip".
  // WHICH run it is comes from this panel's own two params; the gate cannot know.
  if (describe === "already_running") {
    return batch !== null
      ? "shots_panel.describe_sweep_running"
      : "shots_panel.describe_running";
  }
  if (describe !== "describe") return "shots_panel.needs_video_clip";
  // A run in flight, whether a lone press or a sweep. `runDescribe` refuses a
  // second one anyway; greying says why instead of swallowing the press.
  if (batch !== null) return "shots_panel.describe_sweep_running";
  if (describing !== null) return "shots_panel.describe_running";
  // An apply reshapes the very rows a description is being taken over, so the
  // window a press would send may not be a span any more by the time the model
  // answers — `measure_busy`'s rule, and its sentence.
  if (applying !== null) return "shots_panel.measure_busy";
  return null;
}

/// The sweep: describe every shot that has nothing yet, one after another.
///
/// Beside *Measure shots* and for its reasons — it writes no project state and
/// lands no undo entry, it changes what the rows SAY rather than which rows
/// there are, and its cost is the only reason it is not automatic. The count is
/// in the label because that cost is linear in it: N local model runs, and a
/// button that hid the N would be hiding the whole decision.
///
/// While it runs it becomes STOP. A ten-minute sweep with no way out is the one
/// thing *Measure shots* does not have to answer for (three ffmpeg extracts per
/// span), and the stop is honest about what it can do — `cancelDescribeShots`
/// states why it takes effect after the shot in flight.
function DescribeShotsButton({
  rows,
  mediaId,
  describeBlocker,
  onSweep,
}: {
  rows: readonly ShotRow[];
  mediaId: string;
  describeBlocker: string | null;
  onSweep: (rows: readonly ShotRow[]) => void;
}) {
  const { t } = useTranslation();
  const segments = useDescription(mediaId);
  const batch = useDescribeBatch();
  // The rows with no prose over their span — the same intersection the cells
  // render by, so the count names exactly the cells that would fill.
  const undescribed = useMemo(
    () =>
      rows.filter(
        (row) =>
          segmentsForSpan(segments, row.srcStartUs, row.srcEndUs).length === 0,
      ),
    [rows, segments],
  );
  if (batch !== null) {
    return (
      <Button
        className="shots-describe-all"
        variant="secondary"
        size="sm"
        data-testid="shots-describe-all"
        title={t("shots_panel.describe_all_stop_hint")}
        onClick={cancelDescribeShots}
      >
        {t("shots_panel.describe_all_running", {
          done: batch.done,
          total: batch.total,
        })}
      </Button>
    );
  }
  // Nothing left to describe gets the `measure_all_measured` treatment: name the
  // precondition in the tooltip rather than repeat an unusable label.
  const blocker =
    undescribed.length === 0
      ? "shots_panel.describe_all_described"
      : describeBlocker;
  return (
    <Button
      className="shots-describe-all"
      variant="secondary"
      size="sm"
      data-testid="shots-describe-all"
      disabled={blocker !== null}
      title={blocker === null ? t("shots_panel.describe_all_hint") : t(blocker)}
      onClick={() => onSweep(undescribed)}
    >
      {t("shots_panel.describe_all", { count: undescribed.length })}
    </Button>
  );
}

/// One verb. Disabled with the reason in its tooltip rather than with the
/// unusable label repeated, the `quick_actions.clear_range_empty` rule: a greyed
/// button whose tooltip still reads "Split at cuts" is a button that looks
/// broken.
function ShotApplyButton({
  verb,
  variant,
  labelKey,
  testId,
  rows,
  clipName,
  applying,
}: {
  verb: ShotApplyVerb;
  variant: "default" | "secondary" | "destructive";
  labelKey: string;
  testId: string;
  rows: readonly ShotRow[];
  clipName: string;
  applying: ShotApplyVerb | null;
}) {
  const { t } = useTranslation();
  const blocker = shotApplyBlocker(verb, rows, applying);
  const label = t(labelKey);
  return (
    <Button
      className="shots-apply-verb"
      variant={variant}
      size="default"
      data-testid={testId}
      disabled={blocker !== null}
      title={blocker === null ? label : t(blocker)}
      onClick={() => void applyShotVerb(verb, rows, clipName)}
    >
      {label}
    </Button>
  );
}

/// The three verbs over the reviewed list, plus the slot a refusal lands in.
///
/// ABOVE the row list, not below it. `DockWorkspace` scrolls the whole Panel as
/// one, so a bar under a forty-row list is only reachable at the end of a
/// scroll — and the commit for a review has to stay reachable while the review
/// is being read. It also completes the band the threshold line and the length
/// field begin: what shapes the list, then what to do with it, then the list.
///
/// Three variants for three intents: splitting is the plain apply, marking
/// writes nothing away, and discarding deletes segments — the one verb that
/// wants the destructive skin before it is pressed rather than a dialog after.
function ShotApplyBar({
  rows,
  clipName,
}: {
  rows: readonly ShotRow[];
  clipName: string;
}) {
  const applying = useShotApplying();
  const error = useShotError();
  const shared = { rows, clipName, applying };
  return (
    <div className="shots-apply" data-testid="shots-apply">
      <div className="shots-apply-verbs">
        <ShotApplyButton
          verb="split"
          variant="default"
          labelKey="shots_panel.apply_split"
          testId="shots-apply-split"
          {...shared}
        />
        <ShotApplyButton
          verb="mark"
          variant="secondary"
          labelKey="shots_panel.apply_mark"
          testId="shots-apply-mark"
          {...shared}
        />
        <ShotApplyButton
          verb="discard"
          variant="destructive"
          labelKey="shots_panel.apply_discard"
          testId="shots-apply-discard"
          {...shared}
        />
      </div>
      {/* The channel's own sentence — including the one refusal the buttons
          deliberately do not pre-empt, an all-unchecked discard. The log row
          keeps the record (`docs/status-log.md`). */}
      {error !== "" && <p className="shots-error">{error}</p>}
    </div>
  );
}

/// The subject: the PRIMARY selected layer when it is a `VideoClip`, plus the
/// composition it lives in — the rate its timecodes are read at and the clock a
/// row activation seeks on.
///
/// Four atomic subscriptions and no composite selector: each yields either a
/// string or a sub-object of the summary, so an unrelated store tick bails out
/// instead of re-rendering (`feedback_zustand_composite_selector`). The shape is
/// `useAutoCaptionState`'s, for the same reason — a Dock Panel cannot read
/// Timeline's locals.
function useShotSubject(): {
  layer: LayerSummary;
  composition: CompositionSummary;
} | null {
  const primaryId = usePrimaryLayerId();
  const focusedId = useCompositionAnchorStore((s) => s.focusedId);
  const composition = useProjectStore((s) =>
    compositionOrRoot(s.summary, focusedId),
  );
  const layer = useProjectStore((s) =>
    primarySelectedLayer(
      primaryId,
      compositionOrRoot(s.summary, focusedId)?.tracks ?? NO_TRACKS,
    ),
  );
  if (layer === null || composition === null) return null;
  if (layer.params.kind !== "VideoClip") return null;
  return { layer, composition };
}

/// Park the film on a shot's start, in the composition the CLIP lives in: enter
/// that timeline first — a seek means nothing on another one — then project its
/// local start up through the anchor the open just gave it. A clip inside a
/// Group therefore seeks on the Group's clock, not the root's. The two steps
/// the Marker Panel's rows already take.
function activateShotRow(compositionId: string, tStartUs: number): void {
  if (compositionId !== focusedCompositionId() && !openComposition(compositionId, null)) {
    return;
  }
  jumpToTimeUs(focusedRootUs(tStartUs));
}

export function ShotsPanel() {
  const { t } = useTranslation();
  const ordinals = useGroupOrdinals();
  const subject = useShotSubject();
  const layer = subject?.layer ?? null;
  const composition = subject?.composition ?? null;
  // Narrowed once: the row list needs the media id, and the strip needs the
  // clip's SOURCE window — the span its x axis runs across.
  const clip = layer?.params.kind === "VideoClip" ? layer.params : null;
  const mediaId = clip?.media_id ?? null;

  const cached = useShotCached();
  const reduced = useShotReduced();
  const analyzing = useShotAnalyzing();
  const applying = useShotApplying();
  const error = useShotError();
  const vetoed = useVetoedCandidates(mediaId);
  const discarded = useDiscardedRows(mediaId);
  const spanStats = useSpanStats(mediaId);
  const threshold = useShotThreshold();
  const floor = useShotFloor();
  const minShotUs = useShotMinShotUs();
  const floorReport = useShotFloorReport(mediaId);
  // The describe gate and its two in-flight flags. The gate is the Edit-menu
  // command's own (`describeEligibility.ts`), because the Panel's subject IS the
  // primary selection — one rule for both surfaces.
  const describeState = useDescribeState();
  const describing = useDescribing();
  const describeBatch = useDescribeBatch();
  const describeError = useDescribeError();

  // Mount wiring. The defaults read is what the store reduces at, and the reset
  // on unmount is why a reopened Panel never shows an abandoned review.
  //
  // Descriptions are deliberately NOT reset here: prose is a fact about a
  // source for as long as the project holds it, the search index carries the
  // same map, and a corpus that emptied whenever this Panel closed would be one
  // nobody could search. `descriptionsStore.ts` states where its lifetime ends.
  useEffect(() => {
    void loadShotDefaults();
    const unwire = wireShotReviewPrefs();
    return () => {
      unwire();
      resetShotsStore();
      resetFrameLoader();
    };
  }, []);

  // The description column's read, keyed on the media id rather than on the
  // layer: `layer` is a fresh object per summary tick, and this read must not
  // re-run on every unrelated edit. A cache probe that never computes, so
  // selecting a clip costs no model time — `descriptionsStore.ts` is where that
  // rule is enforced.
  useEffect(() => {
    // A refusal is about the clip it was raised on, so it goes when the subject
    // does — `shotsStore` clears its own slot on the same event, and a sentence
    // that outlived its clip would read as a fresh failure on the new one.
    setDescribeError("");
    if (mediaId === null) return;
    void hydrateDescription(mediaId);
  }, [mediaId]);

  // The subject, restated on every summary tick. `setShotSubject` is idempotent
  // on an unchanged one, which is what keeps that from re-probing per keystroke
  // elsewhere in the app.
  useEffect(() => {
    if (layer === null || layer.params.kind !== "VideoClip") {
      setShotSubject(null);
      return;
    }
    setShotSubject({
      layerId: layer.id,
      mediaId: layer.params.media_id,
      srcInUs: layer.params.src_in_us,
      srcOutUs: layer.params.src_out_us,
    });
  }, [layer]);

  const rows = useMemo(
    () =>
      reduced === null || layer === null || composition === null
        ? []
        : shotRows(
            reduced,
            layer,
            { num: composition.fps_num, den: composition.fps_den },
            vetoed,
            discarded,
            spanStats,
          ),
    [reduced, layer, composition, vetoed, discarded, spanStats],
  );

  const clipName = layer ? layerDisplayName(layer, t, ordinals) : "";
  const compositionId = composition?.id ?? null;
  const onActivate = (row: ShotRow): void => {
    if (compositionId !== null) activateShotRow(compositionId, row.tStartUs);
  };

  const describeBlocker = shotDescribeBlocker(
    describeState,
    describing,
    describeBatch,
    applying,
  );
  // The subject a run is against, or null. Built from the LAYER rather than
  // captured, for `setShotSubject`'s reason: `layer` is a fresh object per
  // summary tick, and a run that outlived a re-selection must still name the
  // clip it was started on.
  const describeSubject =
    layer !== null && clip !== null
      ? { layerId: layer.id, mediaId: clip.media_id, clipName }
      : null;
  const onDescribe = (row: ShotRow): void => {
    if (describeSubject === null) return;
    void describeOneShot(row, describeSubject);
  };
  const onSweep = (sweep: readonly ShotRow[]): void => {
    if (describeSubject === null) return;
    void describeShotRows(sweep, describeSubject);
  };

  if (layer === null || clip === null || composition === null) {
    return (
      <div className="shots-panel" data-testid="shots-panel">
        <p className="shots-empty">{t("shots_panel.needs_video_clip")}</p>
      </div>
    );
  }

  const running = analyzing === mediaId;
  if (reduced === null) {
    // "Not analyzed" is claimed ONLY on a probe that answered no. Every other
    // rowless moment — the probe still in flight, or a hit whose reduce has not
    // landed — says it is looking, because claiming a source was never scanned
    // and then filling the list a frame later is a flash that reads as a bug.
    //
    // The button stays live outside a run so this state can never trap: on a
    // hit, Analyze is a cache read, and it is the one way out if the reduce's
    // IPC failed.
    return (
      <div className="shots-panel" data-testid="shots-panel">
        <div className="shots-offer">
          <p className="shots-empty">
            {running
              ? t("shots_panel.analyzing", { clip: clipName })
              : cached === false
                ? t("shots_panel.not_analyzed", { clip: clipName })
                : t("shots_panel.checking")}
          </p>
          <Button
            variant="default"
            size="lg"
            disabled={running}
            onClick={() => void analyzeShotSubject(clipName)}
          >
            {running ? t("shots_panel.analyze_running") : t("shots_panel.analyze")}
          </Button>
          {/* Inline, and the tool's own sentence: a source with no probed
              duration refuses with a re-import instruction, and that is the
              only actionable half of the failure. The status log keeps the
              record (`docs/status-log.md`). */}
          {error !== "" && <p className="shots-error">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="shots-panel" data-testid="shots-panel">
      {/* Above the rows, because the line is what the rows are a consequence
          of. The parameters are `null` only until their reads land, and the
          floor report is what the strip draws — the reduced one has already
          dropped exactly the candidates the strip exists to show. */}
      {threshold !== null && floor !== null && floorReport !== null && (
        <ScoreStrip
          candidates={floorReport.cut_scores}
          srcInUs={clip.src_in_us}
          srcOutUs={clip.src_out_us}
          threshold={threshold}
          floor={floor}
          fpsNum={composition.fps_num}
          fpsDen={composition.fps_den}
          onThresholdChange={setShotThreshold}
          onThresholdCommit={() => void commitShotThreshold()}
        />
      )}
      {/* One band, in the order the review is read: what shapes the list, then
          what to do with it, then the list. Measuring shapes what the rows SAY
          rather than which rows there are, which is why it sits here and not
          among the apply verbs. */}
      <div className="shots-params">
        {minShotUs !== null && <MinShotLengthField minShotUs={minShotUs} />}
        <MeasureShotsButton
          rows={rows}
          clipName={clipName}
          applying={applying}
        />
        <DescribeShotsButton
          rows={rows}
          mediaId={clip.media_id}
          describeBlocker={describeBlocker}
          onSweep={onSweep}
        />
      </div>
      {/* The describe path's own slot, and not `ShotApplyBar`'s: that one is
          documented as exclusive between the scan, a measurement and an apply,
          and a description greys none of them — so it would be the first thing
          able to overwrite a refusal the reviewer had not read yet. */}
      {describeError !== "" && (
        <p className="shots-error" data-testid="shots-describe-error">
          {describeError}
        </p>
      )}
      <ShotApplyBar rows={rows} clipName={clipName} />
      <ul className="shots-list" data-testid="shots-list">
        {rows.map((row) => (
          <ShotRowView
            key={row.srcStartUs}
            row={row}
            mediaId={clip.media_id}
            fpsNum={composition.fps_num}
            fpsDen={composition.fps_den}
            onActivate={onActivate}
            describeBlocker={describeBlocker}
            onDescribe={onDescribe}
          />
        ))}
      </ul>
      {rows.length === 0 && (
        // A scanned source with no interior candidate above the threshold is
        // one shot, or none once the window closes over it — the honest answer,
        // not a failure, and the sentence says which.
        <p className="shots-empty">{t("shots_panel.no_shots")}</p>
      )}
    </div>
  );
}
