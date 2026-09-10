// The Pauses section of the Attribute Panel: measure one clip's pauses against
// a live threshold, hear what a removal would sound like, then mark them or cut
// them.
//
// Boundary: owns the parameters, the detection, the audition and the two write
// verbs. It owns no drawing — the bands are the timeline's, published through
// `state/pausePreviewStore` — and no subject rule: `commands/pauseCommands.ts`
// states that, because the command's gate has to answer it too. See
// `.scratch/pauses/spec.md` Decisions 3, 6, 7, 13, 15, 16 and ADR 0067's
// sibling on where clip analysis lives.
//
// Home is a panel section rather than a dialog because tuning a threshold is
// something a person does WHILE looking at the waveform and playing the clip,
// which a modal takes away.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { listen, type UnlistenFn } from "@/bridge/events";
import { AppNumberField } from "../components/AppNumberField";
import { AppSlider } from "../components/AppSlider";
import { PAUSES_SECTION_ID, resolvePauseSubjectSummary } from "../commands/pauseCommands";
import { logMutationFailure, refusalText } from "../errors/tryMutate";
import { formatWallClock } from "../frames";
import {
  detectPauses,
  getProjectSettings,
  logEmit,
  markPauses,
  MEDIA_JOB_EVENTS,
  removePauses,
  updateProjectSettings,
  type LayerSummary,
  type MediaJobEvent,
  type PauseRegion,
} from "../ipc";
import { layerDisplayName } from "../lib/layerName";
import { startAudition, subjectConformUrl, type AuditionHandle } from "../audition/auditionPlayer";
import { pauseCore, planAudition } from "../audition/planAudition";
import { useAudioFxStatus } from "../state/audioFxStore";
import { LatestRequestCoordinator } from "../state/latestRequest";
import { clearPausePreview, setPausePreview } from "../state/pausePreviewStore";
import { playheadTimeUs } from "../state/playheadStore";
import { useOpenComposition, useProjectStore } from "../state/projectStore";
import { PropSection } from "./PropSection";

/// Rust's own defaults, as the section states them.
///
/// TWIN of `DetectPausesArgs`' and the remove hybrid's `unwrap_or` defaults
/// (`native/src/mcp/tools.rs`, `main/state/hybrids.ts`), and knowingly so: they
/// are recipe constants the `/cut-pauses` prompt states in prose, not a
/// computed property of the build, and the addon exposes no getter for them the
/// way it does for the shot detector's. Change one side and change this one.
///
/// The section always sends its values EXPLICITLY, so these decide only what an
/// untuned project starts at — never what the tool falls back to.
const DEFAULT_THRESHOLD_DB = -34;
const DEFAULT_MIN_MS = 500;
const DEFAULT_PAD_MS = 100;

/// The dB window the slider spans. Below −60 every recording is "silent" and
/// above −20 quiet speech starts counting as a pause, so the ends are the range
/// in which the control has anything to say.
const DB_MIN = -60;
const DB_MAX = -20;
const DB_STEP = 1;

/// Headroom over the measured floor that *Auto* leaves. Six decibels is one
/// doubling of amplitude: under it the detector chases the noise itself, over
/// it a soft word onset starts reading as quiet.
const AUTO_HEADROOM_DB = 6;

/// Floor on the minimum-length field. Not a matter of taste: a region marker
/// must span at least one frame after the composition's snap, and one frame is
/// 16.7 ms at the 60 fps preset ceiling. 50 ms clears that on every rate this
/// editor offers with room to spare.
const MIN_PAUSE_FLOOR_MS = 50;
const MS_STEP = 50;

/// Re-detect settles this long after the last keystroke or slider step. Shorter
/// than the 300 ms `AppNumberField` waits before committing, because nothing
/// here commits — a superseded read costs one cache walk, and the latest-wins
/// guard makes an overlapping pair harmless.
const REDETECT_DEBOUNCE_MS = 120;

/// The three starting points, threshold and minimum only — a preset that also
/// set the pad would overwrite a choice that has nothing to do with how quiet
/// the room is.
const PRESETS = [
  { id: "speech", db: -34, minMs: 500 },
  { id: "noisy", db: -28, minMs: 800 },
  { id: "music", db: -45, minMs: 1500 },
] as const;

/// What the section is showing, or waiting for.
///
/// `waiting_waveform` is a state and not an error, which is the whole point of
/// having it: on a fresh import the peaks the detector reads are still being
/// generated, and a human must not be shown a failure for a job that is simply
/// still running.
type Phase = "detecting" | "ready" | "waiting_waveform" | "failed";

/// Rust's refusal while a source's waveform job is still running names the
/// event to wait for (`native/src/mcp/tools.rs`), and this is what recognises
/// it. Matched on the leading phrase rather than the whole sentence: the media
/// id and the instruction are interpolated, and the message crosses IPC inside
/// Electron's own prose (`errors/tryMutate.ts` documents that wrapping), so
/// anything anchored at either end would break.
function isWaveformPending(err: unknown): boolean {
  return /waveform not generated yet/.test(String(err));
}

const ampFromDb = (db: number): number => 10 ** (db / 20);

/// The slider's position for a stored amplitude. Rounded to the step and
/// clamped to the ends, so a value tuned by an agent through `threshold_amp`
/// still lands ON a stop rather than between two.
function dbFromAmp(amp: number): number {
  if (!(amp > 0)) return DB_MIN;
  const db = Math.round(20 * Math.log10(amp) / DB_STEP) * DB_STEP;
  return Math.min(DB_MAX, Math.max(DB_MIN, db));
}

/// A negative decibel figure the way an audio person writes it: a real minus
/// sign, not a hyphen.
const formatDb = (db: number): string =>
  `${db < 0 ? "−" : ""}${Math.abs(Math.round(db))}`;

/// The pad's ceiling at a given minimum, floored to the field's step.
///
/// The constraint is `2 × pad < min` — a core that cannot exist is a parameter
/// mistake, and Rust and the hybrid both refuse it. Half of `min − 50 ms`
/// leaves the core at least the marker floor wide, and flooring to the step
/// keeps the stepper's own arithmetic inside the bound.
function maxPadMs(minMs: number): number {
  return Math.max(0, Math.floor((minMs - MIN_PAUSE_FLOOR_MS) / 2 / MS_STEP) * MS_STEP);
}

/// The section, mounted for an `Audio` layer and for a `VideoClip` that
/// delegates to one. A clip that plays no sound has no subject and therefore no
/// section at all — the command explains that case instead, because a header
/// with nothing under it is not an explanation.
export function PausesSection({ layer }: { layer: LayerSummary }) {
  const { t } = useTranslation();
  const composition = useOpenComposition();
  const subject = resolvePauseSubjectSummary(layer, composition);
  if (subject === null) return null;
  return (
    <PropSection
      layerKind={layer.kind}
      sectionId={PAUSES_SECTION_ID}
      title={t("property_panel.pauses")}
      defaultCollapsed
    >
      <PausesBody layer={layer} subject={subject} />
    </PropSection>
  );
}

/// Everything the section does, mounted only while it is expanded.
///
/// Mount IS expanded (`PropSection` unmounts a collapsed body), which is what
/// lets the detection, the project-store subscription, the waveform listener
/// and the published bands all be plain effects: a collapsed section holds
/// none of them, and no second "is it open" flag exists to disagree with the
/// tree.
function PausesBody({ layer, subject }: { layer: LayerSummary; subject: LayerSummary }) {
  const { t } = useTranslation();
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_THRESHOLD_DB);
  const [minMs, setMinMs] = useState(DEFAULT_MIN_MS);
  const [padMs, setPadMs] = useState(DEFAULT_PAD_MS);
  const [pauses, setPauses] = useState<readonly PauseRegion[]>([]);
  const [floorAmp, setFloorAmp] = useState(0);
  const [phase, setPhase] = useState<Phase>("detecting");
  const [error, setError] = useState("");
  // WHICH write is in flight, not merely whether one is: both verbs grey while
  // either runs, and each button has to know if the spinner is its own.
  const [busy, setBusy] = useState<null | "mark" | "remove">(null);
  const [auditionJoins, setAuditionJoins] = useState<readonly number[] | null>(null);
  // The parameters are a PROJECT preference, so the first detection has to wait
  // for them: detecting at the defaults first would publish a set the user's
  // own threshold immediately replaces, and the bands would flicker.
  const [hydrated, setHydrated] = useState(false);
  // Bumped to re-run the detect effect without changing a parameter — what a
  // landed waveform job and nothing else needs.
  const [retry, setRetry] = useState(0);
  // One coordinator per mounted section: a superseded read must not publish
  // over the newest one even while the newest is still pending
  // (`state/latestRequest.ts` states the rule).
  const [reads] = useState(() => new LatestRequestCoordinator());
  const audition = useRef<AuditionHandle | null>(null);

  const subjectId = subject.id;
  const mediaId = subject.params.kind === "Audio" ? subject.params.media_id : null;
  const fxStatus = useAudioFxStatus(subjectId);
  // The subject's own window onto its media, as a STRING: a trim, a slip or a
  // move changes which peaks are inside the clip, so a detection taken before
  // one is a set of bands in the wrong places. A string and not an object, so
  // an unrelated project edit re-runs the selector and then bails out on
  // reference equality (`feedback_zustand_composite_selector`).
  const subjectWindow = useProjectStore((s) => {
    const live = s.layerById.get(subjectId);
    if (!live) return "";
    const p = live.params;
    const src = p.kind === "Audio" ? `${p.src_in_us}:${p.src_out_us}` : "";
    return `${live.t_start_us}:${live.t_end_us}:${src}`;
  });

  const thresholdAmp = ampFromDb(thresholdDb);
  const minPauseUs = minMs * 1_000;
  const padUs = padMs * 1_000;

  /// Stop whatever is playing. Idempotent, and the ONE place the ref is
  /// cleared — every trigger (unmount, subject change, parameter change, a
  /// second press) routes through it.
  const stopAudition = (): void => {
    audition.current?.stop();
    audition.current = null;
    setAuditionJoins(null);
  };

  // The project's stored parameters, and again whenever the open PROJECT
  // changes: the section can survive a project swap, and the previous
  // session's noise floor must not silently apply to the next one (the
  // `wireShotReviewPrefs` pattern).
  useEffect(() => {
    let alive = true;
    const hydrate = async (): Promise<void> => {
      let review;
      try {
        review = (await getProjectSettings()).pause_review;
      } catch {
        // No project open: the defaults above stand, and detection may begin.
        if (alive) setHydrated(true);
        return;
      }
      if (!alive) return;
      if (review !== null) {
        setThresholdDb(dbFromAmp(review.threshold_amp));
        setMinMs(Math.round(review.min_pause_us / 1_000));
        setPadMs(Math.round(review.pad_us / 1_000));
      }
      setHydrated(true);
    };
    void hydrate();
    const unsub = useProjectStore.subscribe((s, prev) => {
      if (s.summary?.project_id !== prev.summary?.project_id) void hydrate();
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  /// Remember the parameters on the project. Unrecorded, like the shot review's
  /// and the proxy preferences: tuning a threshold is a preference, and a
  /// gesture that logged undo entries would bury the edit before it.
  const persist = (db: number, min: number, pad: number): void => {
    void updateProjectSettings({
      pause_review: {
        threshold_amp: ampFromDb(db),
        min_pause_us: min * 1_000,
        pad_us: pad * 1_000,
      },
    }).catch((err) => {
      // A preference that cannot be written leaves the section fully usable at
      // the values on screen; they are simply not remembered for next time.
      console.warn("[PausesSection] could not persist the review parameters", err);
    });
  };

  // The live detection. Debounced so a held arrow key does not queue one read
  // per repeat, and latest-wins so what is on screen is always the newest
  // request's answer.
  //
  // `window`, `fxStatus` and `retry` are triggers rather than arguments: the
  // clip's span, the baked sibling and the waveform job each change WHICH peaks
  // the same parameters would read.
  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(() => {
      setPhase("detecting");
      void reads.run(
        () => detectPauses({ layerId: subjectId, thresholdAmp, minPauseUs }),
        (result) => {
          setPauses(result.pauses);
          setFloorAmp(result.noise_floor_amp);
          setPhase("ready");
          setError("");
        },
        (err) => {
          setPauses([]);
          if (isWaveformPending(err)) {
            setPhase("waiting_waveform");
            setError("");
            return;
          }
          setPhase("failed");
          setError(refusalText(err));
        },
      );
    }, REDETECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [reads, hydrated, subjectId, thresholdAmp, minPauseUs, subjectWindow, fxStatus, retry]);

  // A parameter change invalidates what is playing: the excerpt was stitched at
  // the old pad around the old joins, so continuing it would demonstrate an
  // edit the section is no longer offering.
  useEffect(() => {
    stopAudition();
  }, [subjectId, thresholdAmp, minPauseUs, padUs]);

  // The waveform job. Subscribed for as long as the section is open rather than
  // only while waiting: a re-import or a regenerated peaks file changes the
  // answer of a detection that already landed, and the retry costs a cache
  // walk.
  useEffect(() => {
    if (mediaId === null) return;
    let unlisten: UnlistenFn | null = null;
    let stopped = false;
    void (async () => {
      const off = await listen<MediaJobEvent>(MEDIA_JOB_EVENTS.complete, (e) => {
        if (e.payload.kind !== "waveform" || e.payload.media_id !== mediaId) return;
        setRetry((n) => n + 1);
      });
      if (stopped) off();
      else unlisten = off;
    })();
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [mediaId]);

  // What the timeline draws. Republished on every landed detection, on a pad
  // change (the core the darker band shows is the pad's), and on every audition
  // start and stop.
  useEffect(() => {
    setPausePreview({
      subjectLayerId: subjectId,
      pauses: pauses.map((p) => ({ t_start_us: p.t_start_us, t_end_us: p.t_end_us })),
      padUs,
      auditioning: auditionJoins ?? [],
    });
  }, [subjectId, pauses, padUs, auditionJoins]);

  // Teardown: the bands go with the body, and so does anything playing. Its own
  // effect with an empty dependency list, so a parameter change cannot blank a
  // publication it just made.
  useEffect(
    () => () => {
      reads.invalidate();
      stopAudition();
      clearPausePreview(subjectId);
    },
    [reads, subjectId],
  );

  // The pad math the removal will do, run here so the summary's two figures
  // and the timeline's darker core cannot disagree with it (`pauseCore` is the
  // one home for the rule).
  const clipSpan = { tStartUs: subject.t_start_us, tEndUs: subject.t_end_us };
  const removedUs = pauses.reduce((sum, p) => {
    const core = pauseCore(p, padUs, clipSpan);
    return sum + (core === null ? 0 : core.endUs - core.startUs);
  }, 0);
  const resultUs = Math.max(0, subject.t_end_us - subject.t_start_us - removedUs);
  // One gate for both verbs: neither may run while a detection is in flight
  // (the set would not be the one on screen), on a clip with no pauses, or
  // while the other one is mid-commit.
  const canAct = phase === "ready" && pauses.length > 0 && busy === null;
  const preset = PRESETS.find((p) => p.db === thresholdDb && p.minMs === minMs);
  const padCeilingMs = maxPadMs(minMs);

  const applyPreset = (db: number, min: number): void => {
    const pad = Math.min(padMs, maxPadMs(min));
    setThresholdDb(db);
    setMinMs(min);
    setPadMs(pad);
    persist(db, min, pad);
  };

  const commitMin = (value: number): void => {
    const min = Math.max(MIN_PAUSE_FLOOR_MS, Math.round(value));
    // Re-clamped rather than refused: lowering the minimum is the gesture, and
    // a pad the new minimum cannot hold is a consequence of it, not a mistake
    // the user has to undo first.
    const pad = Math.min(padMs, maxPadMs(min));
    setMinMs(min);
    setPadMs(pad);
    persist(thresholdDb, min, pad);
  };

  const auditionResult = (): void => {
    if (auditionJoins !== null) {
      stopAudition();
      return;
    }
    const url = subjectConformUrl(subject);
    if (url === null) return;
    const plan = planAudition(
      pauses,
      padUs,
      {
        tStartUs: subject.t_start_us,
        tEndUs: subject.t_end_us,
        srcInUs: subject.params.kind === "Audio" ? subject.params.src_in_us : 0,
      },
      playheadTimeUs(),
    );
    if (plan.segments.length === 0) return;
    setAuditionJoins(plan.joins);
    audition.current = startAudition({
      url,
      segments: plan.segments,
      onEnded: stopAudition,
      onFailed: (err) => setError(refusalText(err)),
    });
  };

  const clipName = layerDisplayName(subject, t);

  /// Run one of the two write verbs and settle the section around it.
  ///
  /// One shared runner because the two differ only in the call and the words:
  /// the `op_id` pairing, the terminal-row rule and the re-arm on failure are
  /// the same contract, and a second copy of them is a second place to get the
  /// status bar stuck on a spinner.
  const run = async (
    phaseName: "mark" | "remove",
    tool: string,
    started: { message: string; i18n_key: string; i18n_args: Record<string, unknown> },
    call: () => Promise<{ message: string; i18n_key: string; i18n_args: Record<string, unknown> }>,
  ): Promise<void> => {
    if (!canAct) return;
    setError("");
    setBusy(phaseName);
    stopAudition();
    // One `op_id` pairs the Started row with its terminal one
    // (docs/status-log.md). Announced even though the commit is local and
    // quick: what the run changed is not necessarily where the user is looking
    // — the ruler's lower half for a mark, the timeline downstream for a
    // removal — and the log row is the record that it happened.
    const opId = crypto.randomUUID();
    void logEmit({
      level: "info",
      category: { kind: "Project" },
      source: { kind: "User" },
      ...started,
      op_id: opId,
      op_state: { state: "Started" },
    });
    try {
      const done = await call();
      void logEmit({
        level: "info",
        category: { kind: "Project" },
        source: { kind: "User" },
        ...done,
        op_id: opId,
        op_state: { state: "Ok" },
      });
    } catch (err) {
      // The tool's own message, verbatim: it names the parameter range it
      // rejects, the waveform it is still waiting on, or — for a removal — the
      // layer whose position blocked the ripple. A generic "it failed" would
      // throw away the actionable half.
      setError(refusalText(err));
      // Under the run's own `op_id`: the Started row above has to close as
      // `Err`, or the status bar keeps a run spinning that already failed.
      logMutationFailure(err, tool, opId);
    }
    setBusy(null);
  };

  // Both verbs re-detect inside their own call at these very parameters, so
  // what lands is the set the section showed rather than whatever a second read
  // of a changed cache would find.
  const mark = () =>
    run(
      "mark",
      "mark_pauses",
      {
        message: `Marking pauses in ${clipName}`,
        i18n_key: "log.mark_pauses_started",
        i18n_args: { clip: clipName },
      },
      async () => {
        const { markers } = await markPauses({
          layerId: subjectId,
          thresholdAmp,
          minPauseUs,
        });
        return {
          message: `${markers} pause markers added`,
          i18n_key: "log.mark_pauses_done",
          i18n_args: { markers, clip: clipName },
        };
      },
    );

  // The count AND the total: a removal shortens the film, so how much it took
  // out is the fact the record has to carry — the count alone says nothing
  // about how far downstream moved.
  const remove = () =>
    run(
      "remove",
      "remove_pauses",
      {
        message: `Removing pauses from ${clipName}`,
        i18n_key: "log.remove_pauses_started",
        i18n_args: { clip: clipName },
      },
      async () => {
        const result = await removePauses({
          layerId: subjectId,
          thresholdAmp,
          minPauseUs,
          padUs,
        });
        const total = formatWallClock(result.removed_us);
        return {
          message: `${result.removed} pauses removed from ${clipName}, ${total} in all`,
          i18n_key: "log.remove_pauses_done",
          i18n_args: { removed: result.removed, total, clip: clipName },
        };
      },
    );

  return (
    <div className="pauses-body">
      {layer.id !== subjectId && (
        <p className="prop-effect-order-hint" data-testid="pauses-delegated">
          {t("pauses.delegated", { clip: clipName })}
        </p>
      )}
      <div className="pauses-presets">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="pauses-preset"
            aria-pressed={preset?.id === p.id}
            onClick={() => applyPreset(p.db, p.minMs)}
          >
            {t(`pauses.preset_${p.id}`)}
          </button>
        ))}
        {/* Custom is a READOUT, not a choice: there is nothing for it to set,
            and lighting it is how the row says the numbers below are the
            user's own rather than one of the three above. */}
        <span
          className="pauses-preset pauses-preset--custom"
          data-active={preset === undefined}
          data-testid="pauses-preset-custom"
        >
          {t("pauses.preset_custom")}
        </span>
      </div>
      <div className="prop-field">
        <span className="prop-field-label">{t("pauses.threshold")}</span>
        <div className="prop-field-control">
          <AppSlider
            value={thresholdDb}
            min={DB_MIN}
            max={DB_MAX}
            step={DB_STEP}
            ariaLabel={t("pauses.threshold")}
            getAriaValueText={(v) => t("pauses.db", { db: formatDb(v) })}
            onValueChange={setThresholdDb}
            onValueCommitted={(v) => persist(v, minMs, padMs)}
          />
          <span className="pauses-readout">{t("pauses.db", { db: formatDb(thresholdDb) })}</span>
        </div>
      </div>
      {/* The ends say what the two directions MEAN. A dB number is a referent
          only to someone who already knows the room. */}
      <p className="pauses-ends">
        <span>{t("pauses.threshold_low")}</span>
        <span>{t("pauses.threshold_high")}</span>
      </p>
      <p className="pauses-floor">
        <span data-testid="pauses-floor">
          {t("pauses.noise_floor", { db: formatDb(dbFromAmp(floorAmp)) })}
        </span>
        {/* The floor is measured, so *Auto* is the one control here that knows
            something the user does not. */}
        <button
          type="button"
          className="effect-add-trigger"
          onClick={() => {
            const db = Math.min(
              DB_MAX,
              Math.max(DB_MIN, dbFromAmp(floorAmp) + AUTO_HEADROOM_DB),
            );
            setThresholdDb(db);
            persist(db, minMs, padMs);
          }}
        >
          {t("pauses.auto")}
        </button>
      </p>
      <div className="prop-field">
        <span className="prop-field-label">{t("pauses.min_length")}</span>
        <div className="prop-field-control">
          <AppNumberField
            value={minMs}
            min={MIN_PAUSE_FLOOR_MS}
            step={MS_STEP}
            ariaLabel={t("pauses.min_length")}
            onValueChange={setMinMs}
            onCommit={commitMin}
          />
          <span className="settings-toggle-hint">{t("pauses.unit_ms")}</span>
        </div>
      </div>
      <div className="prop-field">
        <span className="prop-field-label">{t("pauses.pad")}</span>
        <div className="prop-field-control">
          <AppNumberField
            value={padMs}
            min={0}
            max={padCeilingMs}
            step={MS_STEP}
            ariaLabel={t("pauses.pad")}
            onValueChange={setPadMs}
            onCommit={(v) => {
              const pad = Math.min(padCeilingMs, Math.max(0, Math.round(v)));
              setPadMs(pad);
              persist(thresholdDb, minMs, pad);
            }}
          />
          <span className="settings-toggle-hint">{t("pauses.unit_ms")}</span>
        </div>
      </div>
      <p className="pauses-summary" data-testid="pauses-summary">
        {phase === "waiting_waveform"
          ? t("pauses.waiting_waveform")
          : phase === "detecting"
            ? t("pauses.detecting")
            : phase === "failed"
              ? ""
              : pauses.length === 0
                ? t("pauses.none")
                : t("pauses.summary", {
                    count: pauses.length,
                    // Wall clock rather than a timecode, and not for want of a
                    // frame rate: a pause is measured by ear, and
                    // `formatWallClock` is the readout whose digits agree with
                    // what the user hears (`frames.ts` states the split).
                    removed: formatWallClock(removedUs),
                    result: formatWallClock(resultUs),
                  })}
      </p>
      {error !== "" && <p className="settings-error" data-testid="pauses-error">{error}</p>}
      <div className="pauses-actions">
        <button
          type="button"
          className="effect-add-trigger"
          disabled={!canAct && auditionJoins === null}
          onClick={auditionResult}
        >
          {auditionJoins === null ? t("pauses.audition") : t("pauses.audition_stop")}
        </button>
        {/* Remove before Mark, so the primary verb sits where a press lands.
            Mark stays the default one: it is the reversible half, and the
            native-NLE habit is that the destructive verb is the deliberate
            second reach. */}
        <button
          type="button"
          className="effect-add-trigger"
          disabled={!canAct}
          onClick={() => void remove()}
        >
          {busy === "remove" ? t("pauses.removing") : t("pauses.remove")}
        </button>
        <button
          type="button"
          className="effect-add-trigger pauses-primary"
          disabled={!canAct}
          onClick={() => void mark()}
        >
          {busy === "mark" ? t("pauses.marking") : t("pauses.mark")}
        </button>
      </div>
      <button
        type="button"
        className="pauses-reset"
        onClick={() => {
          setThresholdDb(DEFAULT_THRESHOLD_DB);
          setMinMs(DEFAULT_MIN_MS);
          setPadMs(DEFAULT_PAD_MS);
          // `null` and not the defaults spelled out: clearing the tuning is
          // what "reset" means, and a project that stores the defaults would
          // stop following a later change to them.
          void updateProjectSettings({ pause_review: null }).catch(() => {});
        }}
      >
        {t("pauses.reset")}
      </button>
    </div>
  );
}
