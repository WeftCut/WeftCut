import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { logMutationFailure, refusalText } from "../errors/tryMutate";
import { applySubtitles, logEmit, transcribeClip } from "../ipc";
import {
  closeAutoCaptionPrompt,
  setAutoCaptionTranscribing,
  useAutoCaptionPromptStore,
} from "./autoCaptionPrompt";

/// Language hints offered as placeholder examples. Not a dropdown: the engines
/// take any ISO-639-1 code and several detect the language better than a user
/// guesses it, so a fixed list of six would read as the supported set. The field
/// stays free text, and empty stays the recommended answer.
const LANGUAGE_EXAMPLES = "en, zh, ja, es, fr, de";

/// Auto-caption: transcribe one clip, then apply the returned SRT as a caption
/// track. One gesture, two steps, and only the second touches the project — so
/// one undo removes the whole track (`add_caption_track` commits once).
///
/// There is no review gate, and that is deliberate: the result is a track of
/// editable `Text` layers and `CaptionsPanel` already edits them per cue, which
/// is strictly more than a review list could offer. Every comparable NLE
/// generates directly for the same reason.
///
/// ONE field, straight from the authored `auto-caption` prompt (`layer_id`,
/// `language`) — nothing invented beyond its parameter set.
///
/// Failures stay INLINE and also land in the status log. Inline wins on
/// proximity (`refusalText`'s docstring states the rule) and the dialog stays
/// open, so the language the user typed and the clip they picked survive a
/// missing API key; the log row is the record.
///
/// Rendered by App rather than by a Panel — see `autoCaptionPrompt.ts`.
export function AutoCaptionDialog({
  /// Reveals the Caption Panel on success. Without it a successful
  /// transcription looks like nothing happened: the cues land on a track whose
  /// editor may well be closed.
  onRevealCaptions,
}: {
  onRevealCaptions: () => void;
}) {
  const { t } = useTranslation();
  const target = useAutoCaptionPromptStore((s) => s.target);
  const transcribing = useAutoCaptionPromptStore((s) => s.transcribing);
  const [language, setLanguage] = useState("");
  const [error, setError] = useState("");

  // Fresh draft per opening: a language left over from the last clip would be
  // silently re-submitted, and a stale error would greet a run that has not
  // started.
  useEffect(() => {
    if (target !== null) {
      setLanguage("");
      setError("");
    }
  }, [target]);

  if (target === null) return null;

  const submit = async () => {
    if (transcribing) return;
    setError("");
    setAutoCaptionTranscribing(true);
    // Multi-second and network-dependent, so the run announces itself: without
    // a Started row the status badge has nothing to spin on and the user cannot
    // tell a slow engine from a dead one. One `op_id` pairs it with the
    // terminal row (docs/status-log.md).
    const opId = crypto.randomUUID();
    void logEmit({
      level: "info",
      category: { kind: "Project" },
      source: { kind: "User" },
      message: `Transcribing ${target.layerName}`,
      i18n_key: "log.auto_caption_started",
      i18n_args: { clip: target.layerName },
      op_id: opId,
      op_state: { state: "Started" },
    });
    try {
      const transcript = await transcribeClip(target.layerId, { language });
      await applySubtitles(transcript.srt);
      void logEmit({
        level: "info",
        category: { kind: "Project" },
        source: { kind: "User" },
        message: `${transcript.segments.length} caption cues added`,
        i18n_key: "log.auto_caption_done",
        i18n_args: { cues: transcript.segments.length, engine: transcript.backend },
        op_id: opId,
        op_state: { state: "Ok" },
      });
      closeAutoCaptionPrompt();
      onRevealCaptions();
    } catch (err) {
      // The tool's own message, verbatim: "no backend available" names Settings
      // → Transcription, `PayloadTooLarge` names the ~13-minute cap, and a
      // speed refusal names `split_layer`. A generic "transcription failed"
      // would throw away the only actionable half.
      setError(refusalText(err));
      // Under the run's own `op_id`, or the Started row above never closes and
      // the status bar keeps a transcription spinning that has already failed.
      logMutationFailure(err, "transcribe_clip", opId);
      setAutoCaptionTranscribing(false);
    }
  };

  return (
    <AppDialog
      title={t("auto_caption.title")}
      onClose={transcribing ? undefined : closeAutoCaptionPrompt}
      panelClassName="new-project-panel"
    >
      <div className="new-project-row">
        <span>{t("auto_caption.clip")}</span>
        <span>{target.layerName}</span>
      </div>
      <label className="new-project-row">
        <span>{t("auto_caption.language")}</span>
        <AppInput
          value={language}
          placeholder={t("auto_caption.language_placeholder")}
          ariaLabel={t("auto_caption.language")}
          onValueChange={setLanguage}
          disabled={transcribing}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !transcribing) {
              e.preventDefault();
              void submit();
            }
          }}
          spellCheck={false}
          autoFocus
        />
        <span className="settings-toggle-hint">
          {t("auto_caption.language_hint", { examples: LANGUAGE_EXAMPLES })}
        </span>
      </label>
      <p className="settings-toggle-hint">{t("auto_caption.note")}</p>
      {error !== "" && <p className="new-project-error">{error}</p>}
      <footer className="new-project-actions">
        <Button size="lg" disabled={transcribing} onClick={closeAutoCaptionPrompt}>
          {t("auto_caption.cancel")}
        </Button>
        <Button
          variant="default"
          size="lg"
          disabled={transcribing}
          onClick={() => void submit()}
        >
          {transcribing ? t("auto_caption.running") : t("auto_caption.confirm")}
        </Button>
      </footer>
    </AppDialog>
  );
}
