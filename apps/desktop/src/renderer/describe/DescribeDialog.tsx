import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { type DescribeFocus } from "../ipc";
import {
  closeDescribePrompt,
  useDescribePromptStore,
} from "./describePrompt";
import {
  DEFAULT_FOCUS,
  DEFAULT_FPS,
  isDefaultView,
  runDescribe,
} from "./describeRun";
import { isDescribingSpan, useDescribing } from "./descriptionsStore";

/// Floor on the sampling field. Rust accepts anything above zero, but below a
/// tenth of a frame per second a minute of footage yields fewer than six frames
/// — the model would be describing stills, not a clip.
const MIN_FPS = 0.1;

/// Ceiling, and Rust's own: `describe_clip` refuses anything outside
/// `(0.0, 30.0]`. Stated here so the field clamps rather than letting a typed
/// 60 travel to a refusal that says the same thing.
const MAX_FPS = 30;

/// One step is half a frame per second: the useful range is roughly 0.5–3, and
/// a whole-number step would make the low half of it unreachable by the
/// steppers.
const FPS_STEP = 0.5;

/// The two focus values in the order the tool states them, each with its label
/// key. A `Record` so a third focus cannot be added without writing the copy
/// that names it.
const FOCUS_LABELS: Record<DescribeFocus, string> = {
  general: "describe.focus_general",
  "shot-type": "describe.focus_shot_type",
};

/// Rust's refusal when nothing is configured to describe with. Matched on the
/// leading phrase rather than the whole sentence: the tool's version ends by
/// naming the two ways to configure one and the resource's names a media id,
/// and both cross IPC inside Electron's own prose (`errors/tryMutate.ts`
/// documents that wrapping), so anything anchored at either end would break.
///
/// A prose refusal, so it carries no structured code to match on instead —
/// `parseCommandError` needs a `{` and there is none.
///
/// This is the ONE failure with a remedy inside the app, which is why it is the
/// one that grows a button. Every other refusal — an explicit engine that is
/// unavailable, a missing endpoint URL, a re-timed clip — is shown verbatim,
/// because the tool's own sentence already names what to go and do.
function isNoBackendConfigured(message: string): boolean {
  return /no video-understanding backend/.test(message);
}

/// Describe one clip's content with a vision model, then read the result on the
/// shot rows.
///
/// TWO fields, both straight from the tool's own parameter set: how densely to
/// sample frames, and what to bias the tags toward. The window is not offered —
/// it defaults to the clip's endpoints, and a human who wants a shorter one
/// describes one SHOT from the Shots Panel, which is the same tool over the
/// boundaries the detector already found and needs no window field to say so.
///
/// The run itself is `describeRun.ts`, shared with those per-shot presses. What
/// stays here is what only a dialog can hold: the two parameters, the inline
/// error slot, and the one remedy button a failure can offer.
///
/// There is no review gate and no editor: the result is prose, and prose from a
/// model has no right answer to check it against. What it needs is to be
/// READABLE where it is useful, which is beside the shot boundaries it explains.
///
/// Failures stay INLINE and also land in the status log, on
/// `AutoCaptionDialog`'s rule: inline wins on proximity and the dialog stays
/// open, so the parameters the user chose survive a missing engine.
///
/// Rendered by App rather than by a Panel — see `describePrompt.ts`.
export function DescribeDialog({
  /// Reveals the Shots Panel on success. Without it a finished description
  /// looks like nothing happened: the segments land on shot rows whose Panel
  /// may well be closed.
  onRevealShots,
  /// Opens Settings → Video understanding, the one remedy this dialog can offer
  /// for a failure. App's, because only App owns the settings modal.
  onOpenSettings,
}: {
  onRevealShots: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const target = useDescribePromptStore((s) => s.target);
  const describing = useDescribing();
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [focus, setFocus] = useState<DescribeFocus>(DEFAULT_FOCUS);
  const [error, setError] = useState("");
  const [needsBackend, setNeedsBackend] = useState(false);

  const running =
    target !== null &&
    isDescribingSpan(describing, target.mediaId, target.srcStartUs, target.srcEndUs);

  // Fresh draft per opening: parameters left over from the last clip would be
  // silently re-submitted, and a stale error would greet a run that has not
  // started.
  useEffect(() => {
    if (target === null) return;
    setFps(DEFAULT_FPS);
    setFocus(DEFAULT_FOCUS);
    setError("");
    setNeedsBackend(false);
  }, [target]);

  if (target === null) return null;

  const atDefaultView = isDefaultView(fps, focus);

  const submit = async () => {
    if (running) return;
    setError("");
    setNeedsBackend(false);
    // The whole layer: no window, so Rust's own endpoints decide. The dialog
    // deliberately offers no window field — a human who wants a shorter one
    // describes a shot from the Shots Panel, or trims the clip.
    const message = await runDescribe(
      {
        layerId: target.layerId,
        mediaId: target.mediaId,
        srcStartUs: target.srcStartUs,
        srcEndUs: target.srcEndUs,
        window: null,
        label: target.layerName,
      },
      { fps, focus },
    );
    if (message !== "") {
      // Inline as well as in the log, `AutoCaptionDialog`'s rule: proximity
      // wins and the dialog stays open, so the parameters the user chose
      // survive a missing engine. `needsBackend` is decided here and not in the
      // run, because the remedy is a button only this surface has.
      setError(message);
      setNeedsBackend(isNoBackendConfigured(message));
      return;
    }
    closeDescribePrompt();
    onRevealShots();
  };

  return (
    <AppDialog
      title={t("describe.title")}
      onClose={running ? undefined : closeDescribePrompt}
      panelClassName="new-project-panel"
    >
      <div className="new-project-row">
        <span>{t("describe.clip")}</span>
        <span>{target.layerName}</span>
      </div>
      <div className="new-project-row">
        <span>{t("describe.sampling")}</span>
        <div className="new-project-size-fields">
          <AppNumberField
            value={fps}
            onValueChange={setFps}
            min={MIN_FPS}
            max={MAX_FPS}
            step={FPS_STEP}
            format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
            ariaLabel={t("describe.sampling")}
            disabled={running}
          />
          <span className="settings-toggle-hint">{t("describe.unit_fps")}</span>
        </div>
        <span className="settings-toggle-hint">{t("describe.sampling_hint")}</span>
      </div>
      <div className="new-project-row">
        <span>{t("describe.focus")}</span>
        {/* A dropdown and not a pair of radios, because every other small enum
            in this app's forms is one (`settings/vlmEngineOptions.tsx`), and a
            two-option control that looks unlike its siblings reads as a
            different kind of choice. */}
        <AppSelect
          value={focus}
          onValueChange={(next) => setFocus(next as DescribeFocus)}
          options={Object.entries(FOCUS_LABELS).map(([value, labelKey]) => ({
            value,
            label: t(labelKey),
          }))}
          ariaLabel={t("describe.focus")}
          disabled={running}
        />
        <span className="settings-toggle-hint">{t("describe.focus_hint")}</span>
      </div>
      <p className="settings-toggle-hint">{t("describe.note")}</p>
      {/* The honest half of the deal, and it is not a warning: only a run at
          the defaults lands in the view `media://{id}/description` serves, so a
          finer or re-focused run is readable now and gone next session. Said
          plainly rather than by disabling the fields — a one-off finer pass is
          a real thing to want. */}
      <p className="settings-toggle-hint">
        {atDefaultView
          ? t("describe.remembered_default")
          : t("describe.remembered_custom", {
              // Interpolated from the constants above, so the sentence cannot
              // name a default the request no longer sends.
              fps: DEFAULT_FPS.toFixed(1),
              focus: t(FOCUS_LABELS[DEFAULT_FOCUS]),
            })}
      </p>
      {error !== "" && (
        <>
          <p className="new-project-error">{error}</p>
          {needsBackend && (
            <Button size="default" onClick={onOpenSettings}>
              {t("describe.open_settings")}
            </Button>
          )}
        </>
      )}
      <footer className="new-project-actions">
        <Button size="lg" disabled={running} onClick={closeDescribePrompt}>
          {t("describe.cancel")}
        </Button>
        <Button
          variant="default"
          size="lg"
          disabled={running}
          onClick={() => void submit()}
        >
          {running ? t("describe.running") : t("describe.confirm")}
        </Button>
      </footer>
    </AppDialog>
  );
}
