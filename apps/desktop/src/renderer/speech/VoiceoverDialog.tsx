import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";

import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { logMutationFailure, refusalText } from "../errors/tryMutate";
import { formatTimecode } from "../frames";
import { logEmit, synthesizeSpeech } from "../ipc";
import { trackDisplayName } from "../lib/trackName";
import { usePlayheadTimeUs } from "../state/playheadStore";
import { useProjectSummary } from "../state/projectStore";
import {
  defaultVoiceoverTrackId,
  rootOrNull,
  VOICEOVER_SCRIPT_MAX,
  VOICEOVER_SPEED_DEFAULT,
  VOICEOVER_SPEED_MAX,
  VOICEOVER_SPEED_MIN,
  VOICEOVER_VOICES,
  voiceoverStartUs,
  voiceoverTrackOptions,
  type VoiceoverPlacement,
} from "./voiceoverPlacement";
import { closeVoiceoverPrompt, useVoiceoverPromptStore } from "./voiceoverPrompt";

const PLACEMENTS: readonly VoiceoverPlacement[] = ["append", "playhead"];

/// Voiceover: synthesize a script and attach it as an Audio layer, in one commit
/// — so one undo removes it.
///
/// Reachable with nothing selected, which is the whole reason it is a dialog and
/// not a clip action: this operation has no scope. It needs a script.
///
/// Every field comes from the authored `voiceover` prompt (`script`, `voice`,
/// `speed`, `target_track_id`) plus one addition, the placement choice: "at the
/// playhead" is what a human usually means, and the tool's own default (append
/// at the end) is what an agent gets.
///
/// The destination is STATED and then sent explicitly, `target_track_id`
/// included even when it matches what the hybrid would have chosen on its own:
/// the dialog promising one track while the arm silently resolves another is the
/// failure this closes.
///
/// Nothing here logs the script. The log rows carry its LENGTH and the voice, so
/// a run is identifiable in the record without the record holding what was said
/// — the same treatment `main/mcp/withLog.ts` gives an `apply_subtitles` body on
/// the agent path.
///
/// Rendered by App rather than by a Panel — see `voiceoverPrompt.ts`.
export function VoiceoverDialog() {
  const { t } = useTranslation();
  const open = useVoiceoverPromptStore((s) => s.open);
  const summary = useProjectSummary();
  // Root time, which is the clock both placements are expressed in — the
  // composition's `duration_us` and `playheadStore` agree on it (ADR 0053).
  const playheadUs = usePlayheadTimeUs();
  const [script, setScript] = useState("");
  const [voice, setVoice] = useState<string>(VOICEOVER_VOICES[0]);
  const [speed, setSpeed] = useState(VOICEOVER_SPEED_DEFAULT);
  const [placement, setPlacement] = useState<VoiceoverPlacement>("append");
  const [trackId, setTrackId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const root = rootOrNull(summary);
  const tracks = voiceoverTrackOptions(root);
  const fallbackTrackId = defaultVoiceoverTrackId(root);

  // Fresh draft per opening. The track resets to the arm's own default rather
  // than to the last choice: the default is a fact about the project, and a
  // remembered id can name a track a later edit removed.
  useEffect(() => {
    if (open) {
      setScript("");
      setVoice(VOICEOVER_VOICES[0]);
      setSpeed(VOICEOVER_SPEED_DEFAULT);
      setPlacement("append");
      setTrackId(fallbackTrackId);
      setGenerating(false);
      setError("");
    }
    // `fallbackTrackId` is deliberately out of the deps: it is the SEED of an
    // editable field, and re-seeding on a project tick would move the user's
    // chosen track out from under them mid-edit.
  }, [open]);

  const trackOptions = useMemo(
    () =>
      tracks.map((track) => ({
        value: track.id,
        label: trackDisplayName(track, tracks, t),
      })),
    [tracks, t],
  );

  if (!open) return null;

  const chars = script.length;
  const overBy = chars - VOICEOVER_SCRIPT_MAX;
  // Named so the reason can be SHOWN, not just used to grey the button: an
  // over-long script is refused in the field, before any request is made.
  const refusal =
    script.trim() === ""
      ? t("voiceover.script_empty")
      : overBy > 0
        ? t("voiceover.script_too_long", { over: overBy, max: VOICEOVER_SCRIPT_MAX })
        : null;
  const canConfirm = refusal === null && !generating;

  const startUs = voiceoverStartUs(placement, root, playheadUs);
  const timeAt = (p: VoiceoverPlacement): string =>
    formatTimecode(
      voiceoverStartUs(p, root, playheadUs),
      root?.fps_num ?? 30,
      root?.fps_den ?? 1,
    );

  const submit = async () => {
    if (!canConfirm) return;
    setError("");
    setGenerating(true);
    const opId = crypto.randomUUID();
    void logEmit({
      level: "info",
      category: { kind: "Project" },
      source: { kind: "User" },
      message: `Generating voiceover (${chars} characters, ${voice})`,
      i18n_key: "log.voiceover_started",
      i18n_args: { chars, voice },
      op_id: opId,
      op_state: { state: "Started" },
      // The script is NOT here, and neither is anything that could reconstruct
      // it. Length and voice identify the run; the words are the user's.
      details: { context: "synthesize_speech", chars, voice, speed },
    });
    try {
      const result = await synthesizeSpeech({
        text: script,
        voice,
        // Omitted at the default so the request matches an agent's default-speed
        // call byte for byte: the TTS cache keys an absent speed apart from an
        // explicit 1.0 (`ipc/index.ts` on `speed`).
        ...(speed === VOICEOVER_SPEED_DEFAULT ? {} : { speed }),
        // Explicit even when it equals the arm's own default — see the note on
        // stating the destination above. Omitted only when the project has no
        // track at all, which is the one case the arm has to answer itself.
        ...(trackId ? { target_track_id: trackId } : {}),
        t_start_us: startUs,
      });
      void logEmit({
        level: "info",
        category: { kind: "Project" },
        source: { kind: "User" },
        message: result.cached
          ? "Voiceover added — reused cached audio"
          : "Voiceover added",
        i18n_key: result.cached ? "log.voiceover_done_cached" : "log.voiceover_done",
        i18n_args: { chars, voice },
        op_id: opId,
        op_state: { state: "Ok" },
        details: { context: "synthesize_speech", cached: result.cached, layer: result.layer_id },
      });
      closeVoiceoverPrompt();
    } catch (err) {
      // The resolver's own message, verbatim: "no TTS provider configured"
      // already points at the key editor, and a generic failure would throw
      // that away.
      setError(refusalText(err));
      // Under the run's own `op_id`, so the Started row above closes as `Err`
      // instead of spinning on in the status bar.
      logMutationFailure(err, "synthesize_speech", opId);
      setGenerating(false);
    }
  };

  return (
    <AppDialog
      title={t("voiceover.title")}
      onClose={generating ? undefined : closeVoiceoverPrompt}
      panelClassName="new-project-panel"
    >
      <label className="new-project-row">
        <span>{t("voiceover.script")}</span>
        <textarea
          className="app-input"
          aria-label={t("voiceover.script")}
          value={script}
          rows={6}
          disabled={generating}
          spellCheck={false}
          autoFocus
          onChange={(e) => setScript(e.target.value)}
        />
        {/* One line, two skins: the count is neutral information until it is
            the reason the button is off, and only then does it turn red. */}
        <span
          className={
            refusal !== null ? "new-project-validation" : "settings-toggle-hint"
          }
        >
          {t("voiceover.script_count", { chars, max: VOICEOVER_SCRIPT_MAX })}
          {refusal !== null ? ` — ${refusal}` : ""}
        </span>
      </label>
      <label className="new-project-row">
        <span>{t("voiceover.voice")}</span>
        <AppSelect
          value={voice}
          onValueChange={setVoice}
          disabled={generating}
          ariaLabel={t("voiceover.voice")}
          options={VOICEOVER_VOICES.map((v) => ({ value: v, label: v }))}
        />
      </label>
      <label className="new-project-row">
        <span>{t("voiceover.speed")}</span>
        <AppNumberField
          value={speed}
          onValueChange={setSpeed}
          min={VOICEOVER_SPEED_MIN}
          max={VOICEOVER_SPEED_MAX}
          step={0.05}
          disabled={generating}
          ariaLabel={t("voiceover.speed")}
        />
      </label>
      {trackOptions.length > 0 && (
        <label className="new-project-row">
          <span>{t("voiceover.track")}</span>
          <AppSelect
            value={trackId ?? ""}
            onValueChange={setTrackId}
            disabled={generating}
            ariaLabel={t("voiceover.track")}
            options={trackOptions}
          />
        </label>
      )}
      <div className="new-project-row">
        <span>{t("voiceover.placement")}</span>
        <RadioGroup
          className="settings-radio-cards"
          value={placement}
          aria-label={t("voiceover.placement")}
          onValueChange={(next) => setPlacement(next as VoiceoverPlacement)}
        >
          {PLACEMENTS.map((p) => (
            <Radio.Root
              key={p}
              value={p}
              disabled={generating}
              className="settings-radio-card"
            >
              <span className="settings-radio-card-dot" aria-hidden="true">
                <Radio.Indicator className="settings-radio-card-indicator" />
              </span>
              <span className="settings-radio-card-text">
                <span className="settings-radio-card-title">
                  {t(`voiceover.placement_${p}`)}
                </span>
                <span className="settings-radio-card-desc">
                  {t(`voiceover.placement_${p}_desc`, { time: timeAt(p) })}
                </span>
              </span>
            </Radio.Root>
          ))}
        </RadioGroup>
      </div>
      <p className="settings-toggle-hint">{t("voiceover.cost")}</p>
      {error !== "" && <p className="new-project-error">{error}</p>}
      <footer className="new-project-actions">
        <Button size="lg" disabled={generating} onClick={closeVoiceoverPrompt}>
          {t("voiceover.cancel")}
        </Button>
        <Button
          variant="default"
          size="lg"
          disabled={!canConfirm}
          onClick={() => void submit()}
        >
          {generating ? t("voiceover.running") : t("voiceover.confirm")}
        </Button>
      </footer>
    </AppDialog>
  );
}
