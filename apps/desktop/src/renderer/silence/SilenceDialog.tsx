import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { listen, type UnlistenFn } from "@/bridge/events";
import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { AppNumberField } from "../components/AppNumberField";
import { logMutationFailure, refusalText } from "../errors/tryMutate";
import { formatWallClock } from "../frames";
import {
  detectSilences,
  logEmit,
  markSilences,
  MEDIA_JOB_EVENTS,
  removeSilences,
  type MediaJobEvent,
  type SilenceRegion,
} from "../ipc";
import { LatestRequestCoordinator } from "../state/latestRequest";
import { closeSilencePrompt, useSilencePromptStore } from "./silencePrompt";

/// The two parameters of the authored `cut-silences` prompt, at the values an
/// omitted argument resolves to in Rust.
///
/// TWIN of `DetectSilencesArgs`' `unwrap_or` defaults in
/// `native/src/mcp/tools.rs`, and knowingly so: they are recipe constants the
/// prompt itself states in prose, not a computed property of the build, and the
/// addon exposes no getter for them the way it does for the shot detector's
/// (`shot_default_opts`). Change one side and change this one — a preview taken
/// at a different threshold from the mark it produces is the failure this
/// pairing risks.
///
/// Stated once here and read from nowhere else in this module, so the field, the
/// helper text and the request cannot disagree about what "default" means.
const DEFAULT_THRESHOLD_AMP = 0.02;
const DEFAULT_MIN_SILENCE_MS = 500;

/// Floor on the minimum-length field. Not a matter of taste: a region marker
/// must span at least one frame after the composition's snap (`snapMarkerTimes`
/// refuses a collapsed span, and the refusal would take the whole batch with
/// it), and one frame is 16.7 ms at the 60 fps preset ceiling. 50 ms clears that
/// on every rate this editor offers with room to spare.
const MIN_SILENCE_FLOOR_MS = 50;

/// Re-detect settles this long after the last keystroke or stepper click.
/// Shorter than the 300 ms `AppNumberField` waits before committing, because
/// nothing here commits — a superseded read costs one cache walk, and the
/// latest-wins guard makes an overlapping pair harmless. Long enough that
/// holding an arrow key down does not queue one read per repeat.
const REDETECT_DEBOUNCE_MS = 120;

/// What the preview is showing, or waiting for.
///
/// `waiting_waveform` is a state and not an error, which is the whole point of
/// having it: on a fresh import the peaks the detector reads are still being
/// generated, and a human must not be shown a failure for a job that is simply
/// still running. The authored recipe instructs agents to wait on the same
/// event, so both paths behave the same way.
type PreviewState = "detecting" | "ready" | "waiting_waveform" | "failed";

/// Rust's refusal while a source's waveform job is still running names the
/// event to wait for (`native/src/mcp/tools.rs`), and this is what recognises
/// it. Matched on the leading phrase rather than the whole sentence: the media
/// id and the instruction are interpolated, and the message crosses IPC inside
/// Electron's own prose (`errors/tryMutate.ts` documents that wrapping), so
/// anything anchored at either end would break.
///
/// A prose refusal, so it carries no structured code to match on instead —
/// `parseCommandError` needs a `{` and there is none.
function isWaveformPending(err: unknown): boolean {
  return /waveform not generated yet/.test(String(err));
}

/// Amplitude as the decibel figure the recipe explains it in. A peak threshold
/// of 0.02 is "≈ -34 dBFS", and dBFS is the unit an audio person actually
/// reasons about — but amplitude is what the tool takes, so the number stays
/// the field and the decibels stay the annotation.
///
/// Zero has no logarithm; a threshold of zero means "nothing is silent", and
/// `-∞` says that correctly.
function dbfsOf(amp: number): string {
  if (amp <= 0) return "-∞";
  return (20 * Math.log10(amp)).toFixed(1);
}

/// Detect a clip's silent ranges, tune the two parameters against a live
/// preview, then either mark every range or cut them all out.
///
/// The preview is the review surface, and it is deliberately a LIST rather than
/// a Panel: verifying one silent range means listening to it, which costs more
/// than marking the set and deleting the marks you disagree with. What the list
/// has to answer is "how much of this clip is silence, and where" — a count, a
/// total and the ranges themselves.
///
/// Every parameter change re-detects, because detection reads the pre-computed
/// waveform peaks rather than decoding: the read is a cache walk, so a live
/// control costs what a static one would.
///
/// Nothing is written until one of the two actions is pressed, and nothing at
/// all is written when the clip has no silence above the threshold — both
/// buttons grey and the list says so plainly. *Mark silences* leaves the film
/// exactly as long as it was; *Remove* cuts each range out and closes the gap
/// behind it, as one recorded edit.
///
/// Failures stay INLINE and also land in the status log, on
/// `AutoCaptionDialog`'s rule: inline wins on proximity and the dialog stays
/// open, so the parameters the user tuned survive a failure. A removal's
/// refusals are the ripple planner's and they NAME the layer that blocked, so
/// showing the tool's own words is what makes the dialog actionable — a
/// generic failure would send the user hunting for a clip the message already
/// identified.
///
/// Rendered by App rather than by a Panel — see `silencePrompt.ts`.
export function SilenceDialog() {
  const { t } = useTranslation();
  const target = useSilencePromptStore((s) => s.target);
  const [thresholdAmp, setThresholdAmp] = useState(DEFAULT_THRESHOLD_AMP);
  const [minSilenceMs, setMinSilenceMs] = useState(DEFAULT_MIN_SILENCE_MS);
  const [regions, setRegions] = useState<readonly SilenceRegion[]>([]);
  const [preview, setPreview] = useState<PreviewState>("detecting");
  const [error, setError] = useState("");
  // WHICH write is in flight, not merely whether one is: both actions grey
  // while either runs, and each button has to know if the spinner is its own.
  const [busy, setBusy] = useState<null | "mark" | "remove">(null);
  // One coordinator per mounted dialog, not per module: a superseded read must
  // not publish over the newest one even while the newest is still pending
  // (`state/latestRequest.ts` states the rule), and closing the dialog has to
  // be able to silence every read in flight. Lazily initialised state rather
  // than a ref, so the constructor runs once instead of on every render.
  const [reads] = useState(() => new LatestRequestCoordinator());
  // Bumped to re-run the detect effect without changing a parameter — what the
  // waveform-ready event and nothing else needs.
  const [retry, setRetry] = useState(0);

  const layerId = target?.layerId ?? null;
  const mediaId = target?.mediaId ?? null;

  // Fresh draft per opening: parameters left over from the last clip would be
  // silently re-submitted, and a stale error would greet a run that has not
  // started.
  useEffect(() => {
    if (layerId === null) return;
    setThresholdAmp(DEFAULT_THRESHOLD_AMP);
    setMinSilenceMs(DEFAULT_MIN_SILENCE_MS);
    setRegions([]);
    setPreview("detecting");
    setError("");
    setBusy(null);
  }, [layerId]);

  // The live preview. Debounced so a held arrow key does not queue one read per
  // repeat, and latest-wins so the answer on screen is always the newest
  // request's — a slower earlier read must not overwrite it.
  useEffect(() => {
    if (layerId === null) return;
    const timer = setTimeout(() => {
      setPreview("detecting");
      void reads.run(
        () =>
          detectSilences({
            layerId,
            thresholdAmp,
            minSilenceUs: minSilenceMs * 1_000,
          }),
        (found) => {
          setRegions(found);
          setPreview("ready");
          setError("");
        },
        (err) => {
          setRegions([]);
          if (isWaveformPending(err)) {
            setPreview("waiting_waveform");
            setError("");
            return;
          }
          setPreview("failed");
          setError(refusalText(err));
        },
      );
    }, REDETECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [reads, layerId, thresholdAmp, minSilenceMs, retry]);

  // Stop every read in flight from publishing into a closed dialog. Its own
  // effect because the coordinator outlives each read: invalidating inside the
  // read effect's cleanup would cancel the read that its own parameter change
  // just issued.
  useEffect(() => {
    if (layerId !== null) return;
    reads.invalidate();
  }, [reads, layerId]);

  // The waveform wait. Subscribed only while actually waiting, so an ordinary
  // session holds no listener, and torn down on close — a retry firing into a
  // dialog the user has dismissed would issue a read nobody is looking at.
  useEffect(() => {
    if (preview !== "waiting_waveform" || mediaId === null) return;
    let unlisten: UnlistenFn | null = null;
    let stopped = false;
    void (async () => {
      const off = await listen<MediaJobEvent>(MEDIA_JOB_EVENTS.complete, (e) => {
        if (e.payload.kind !== "waveform" || e.payload.media_id !== mediaId)
          return;
        setRetry((n) => n + 1);
      });
      if (stopped) off();
      else unlisten = off;
    })();
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [preview, mediaId]);

  if (target === null) return null;

  const totalSilentUs = regions.reduce(
    (sum, r) => sum + (r.t_end_us - r.t_start_us),
    0,
  );
  // One gate for both actions: neither may run while a detection is in flight
  // (the set would not be the one on screen), on a clip with nothing silent, or
  // while the other one is mid-commit.
  const canAct = preview === "ready" && regions.length > 0 && busy === null;

  /// Run one of the two write verbs and settle the dialog around it: success
  /// closes, a refusal stays open with the tool's own words in the error slot.
  ///
  /// One shared runner because the two differ only in the call and the words:
  /// the `op_id` pairing, the terminal-row rule and the re-arm on failure are
  /// the same contract, and a second copy of them is a second place to get the
  /// status bar stuck on a spinner.
  const run = async (
    phase: "mark" | "remove",
    tool: string,
    started: { message: string; i18n_key: string; i18n_args: Record<string, unknown> },
    call: () => Promise<{ message: string; i18n_key: string; i18n_args: Record<string, unknown> }>,
  ) => {
    if (!canAct) return;
    setError("");
    setBusy(phase);
    // One `op_id` pairs the Started row with its terminal one
    // (docs/status-log.md). Announced even though the commit is local and quick:
    // what the run changed is not necessarily where the user is looking — the
    // ruler's lower half for a mark, the timeline downstream for a removal —
    // and the log row is the record that it happened.
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
      closeSilencePrompt();
    } catch (err) {
      // The tool's own message, verbatim: it names the layer kind it refuses,
      // the parameter range it rejects, the waveform it is still waiting on, or
      // — for a removal — the layer whose position blocked the ripple. A
      // generic "it failed" would throw away the actionable half.
      setError(refusalText(err));
      // Under the run's own `op_id`: the Started row above has to close as
      // `Err`, or the status bar keeps a run spinning that already failed.
      logMutationFailure(err, tool, opId);
      setBusy(null);
    }
  };

  // Both verbs re-detect inside their own call at these very parameters, so
  // what lands is the set the list showed rather than whatever a second read of
  // a changed cache would find.
  const mark = () =>
    run(
      "mark",
      "mark_silences",
      {
        message: `Marking silences in ${target.layerName}`,
        i18n_key: "log.mark_silences_started",
        i18n_args: { clip: target.layerName },
      },
      async () => {
        const { markers } = await markSilences({
          layerId: target.layerId,
          thresholdAmp,
          minSilenceUs: minSilenceMs * 1_000,
        });
        return {
          message: `${markers} silence markers added`,
          i18n_key: "log.mark_silences_done",
          i18n_args: { markers, clip: target.layerName },
        };
      },
    );

  // The count AND the total: a removal shortens the film, so how much it took
  // out is the fact the record has to carry — the count alone says nothing
  // about how far downstream moved.
  const remove = () =>
    run(
      "remove",
      "remove_silences",
      {
        message: `Removing silences from ${target.layerName}`,
        i18n_key: "log.remove_silences_started",
        i18n_args: { clip: target.layerName },
      },
      async () => {
        const result = await removeSilences({
          layerId: target.layerId,
          thresholdAmp,
          minSilenceUs: minSilenceMs * 1_000,
        });
        const total = formatWallClock(result.removed_us);
        return {
          message: `${result.removed} silent ranges removed from ${target.layerName}, ${total} in all`,
          i18n_key: "log.remove_silences_done",
          i18n_args: { removed: result.removed, total, clip: target.layerName },
        };
      },
    );

  return (
    <AppDialog
      title={t("silence.title")}
      onClose={busy === null ? closeSilencePrompt : undefined}
      panelClassName="new-project-panel"
    >
      <div className="new-project-row">
        <span>{t("silence.clip")}</span>
        <span>{target.layerName}</span>
      </div>
      <div className="new-project-row">
        <span>{t("silence.threshold")}</span>
        <div className="new-project-size-fields">
          <AppNumberField
            value={thresholdAmp}
            onValueChange={setThresholdAmp}
            min={0}
            max={1}
            step={0.005}
            format={{ minimumFractionDigits: 3, maximumFractionDigits: 3 }}
            ariaLabel={t("silence.threshold")}
            disabled={busy !== null}
          />
        </div>
        <span className="settings-toggle-hint">
          {t("silence.threshold_hint", { dbfs: dbfsOf(thresholdAmp) })}
        </span>
      </div>
      <div className="new-project-row">
        <span>{t("silence.min_length")}</span>
        <div className="new-project-size-fields">
          <AppNumberField
            value={minSilenceMs}
            onValueChange={setMinSilenceMs}
            min={MIN_SILENCE_FLOOR_MS}
            step={50}
            ariaLabel={t("silence.min_length")}
            disabled={busy !== null}
          />
          <span className="settings-toggle-hint">{t("silence.unit_ms")}</span>
        </div>
        <span className="settings-toggle-hint">{t("silence.min_length_hint")}</span>
      </div>
      <div className="silence-preview">
        {preview === "waiting_waveform" ? (
          <p className="settings-toggle-hint">{t("silence.waiting_waveform")}</p>
        ) : preview === "detecting" ? (
          <p className="settings-toggle-hint">{t("silence.detecting")}</p>
        ) : preview === "failed" ? null : regions.length === 0 ? (
          <p className="settings-toggle-hint">{t("silence.none")}</p>
        ) : (
          <>
            <p className="silence-summary">
              {t("silence.summary", {
                count: regions.length,
                total: formatWallClock(totalSilentUs),
              })}
            </p>
            {/* Wall clock rather than a timecode, and not for want of a frame
                rate: a silent stretch is measured by ear, and `formatWallClock`
                is the readout whose digits agree with what the user hears
                (`frames.ts` states the split). */}
            <ul className="silence-ranges">
              {regions.map((r) => (
                <li key={`${r.t_start_us}-${r.t_end_us}`}>
                  {t("silence.range", {
                    start: formatWallClock(r.t_start_us),
                    end: formatWallClock(r.t_end_us),
                  })}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <p className="settings-toggle-hint">{t("silence.note")}</p>
      {error !== "" && <p className="new-project-error">{error}</p>}
      <footer className="new-project-actions">
        <Button size="lg" disabled={busy !== null} onClick={closeSilencePrompt}>
          {t("silence.cancel")}
        </Button>
        {/* Mark stays the default press: it is the reversible one, and the
            native-NLE habit is that the destructive verb is the deliberate
            second reach rather than the button Enter lands on. */}
        <Button size="lg" disabled={!canAct} onClick={() => void remove()}>
          {busy === "remove" ? t("silence.removing") : t("silence.remove")}
        </Button>
        <Button
          variant="default"
          size="lg"
          disabled={!canAct}
          onClick={() => void mark()}
        >
          {busy === "mark" ? t("silence.running") : t("silence.confirm")}
        </Button>
      </footer>
    </AppDialog>
  );
}
