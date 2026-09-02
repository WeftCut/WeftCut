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
import { formatMediaDuration, formatTimecode } from "../frames";
import {
  getMediaFrame,
  type CompositionSummary,
  type LayerSummary,
  type ShotFlag,
  type TrackSummary,
} from "../ipc";
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
import { shotRows, type ShotCandidate, type ShotRow } from "./shotRows";
import {
  analyzeShotSubject,
  loadShotDefaults,
  resetShotsStore,
  setCandidateAccepted,
  setRowKept,
  setShotSubject,
  useDiscardedRows,
  useShotAnalyzing,
  useShotCached,
  useShotError,
  useShotReduced,
  useVetoedCandidates,
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

/// The three stats, or the absent marker. A row whose span the scan never
/// sampled — every merged or window-truncated span — shows a dash, because `0`
/// would report a black, motionless, out-of-focus shot that was simply never
/// measured.
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
}: {
  row: ShotRow;
  mediaId: string;
  fpsNum: number;
  fpsDen: number;
  onActivate: (row: ShotRow) => void;
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
  const mediaId =
    layer?.params.kind === "VideoClip" ? layer.params.media_id : null;

  const cached = useShotCached();
  const reduced = useShotReduced();
  const analyzing = useShotAnalyzing();
  const error = useShotError();
  const vetoed = useVetoedCandidates(mediaId);
  const discarded = useDiscardedRows(mediaId);

  // Mount wiring. The defaults read is what the store reduces at, and the reset
  // on unmount is why a reopened Panel never shows an abandoned review.
  useEffect(() => {
    void loadShotDefaults();
    return () => {
      resetShotsStore();
      resetFrameLoader();
    };
  }, []);

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
          ),
    [reduced, layer, composition, vetoed, discarded],
  );

  const clipName = layer ? layerDisplayName(layer, t, ordinals) : "";
  const compositionId = composition?.id ?? null;
  const onActivate = (row: ShotRow): void => {
    if (compositionId !== null) activateShotRow(compositionId, row.tStartUs);
  };

  if (layer === null || mediaId === null || composition === null) {
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
      <ul className="shots-list" data-testid="shots-list">
        {rows.map((row) => (
          <ShotRowView
            key={row.srcStartUs}
            row={row}
            mediaId={mediaId}
            fpsNum={composition.fps_num}
            fpsDen={composition.fps_den}
            onActivate={onActivate}
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
