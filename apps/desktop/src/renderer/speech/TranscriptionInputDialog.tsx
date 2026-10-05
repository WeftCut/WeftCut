import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { answerTranscriptionInput, useTranscriptionInputPrompt } from "./transcriptionInputPrompt";
import { estimatedNormalizationGain } from "./transcriptionInput";

export function TranscriptionInputDialog() {
  const { t } = useTranslation();
  const pending = useTranscriptionInputPrompt(s => s.pending);
  if (!pending) return null;
  const quiet = pending.issues.filter(i => i.kind === "quiet");
  const unavailable = pending.issues.filter(i => i.kind === "unavailable");
  const canNormalize = quiet.some(i => i.peakDbfs !== null);
  return (
    <AppDialog title={t("transcription_input.title")} panelClassName="new-project-panel" onClose={() => answerTranscriptionInput("cancel")}>
      <div className="max-h-[50vh] overflow-y-auto space-y-3 text-sm">
        {quiet.length > 0 && <section>
          <p>{t("transcription_input.quiet")}</p>
          <ul className="list-disc pl-5 break-words">{quiet.map(i => <li key={i.layerId}>
            {i.label}{i.peakDbfs !== null && <span> — {t("transcription_input.estimate", { gain: estimatedNormalizationGain(i.peakDbfs).toFixed(1) })}</span>}
          </li>)}</ul>
        </section>}
        {unavailable.length > 0 && <section>
          <p>{t("transcription_input.unavailable")}</p>
          <ul className="list-disc pl-5 break-words">{unavailable.map(i => <li key={i.layerId}>{i.label}</li>)}</ul>
        </section>}
        <p>{t("transcription_input.unchanged")}</p>
        {canNormalize && <p>{t("transcription_input.normalize_note")}</p>}
        <p>{t("transcription_input.remedy")}</p>
      </div>
      <footer className="new-project-actions flex-wrap">
        <Button size="lg" onClick={() => answerTranscriptionInput("cancel")}>{t("transcription_input.cancel")}</Button>
        <Button size="lg" onClick={() => answerTranscriptionInput("original")}>{t("transcription_input.continue")}</Button>
        {canNormalize && <Button variant="default" size="lg" onClick={() => answerTranscriptionInput("normalize")}>{t("transcription_input.normalize")}</Button>}
      </footer>
    </AppDialog>
  );
}
