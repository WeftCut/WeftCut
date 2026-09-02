import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { logMutationFailure, refusalText } from "../errors/tryMutate";
import { describeClip, logEmit, type DescribeFocus } from "../ipc";
import {
  closeDescribePrompt,
  useDescribePromptStore,
} from "./describePrompt";
import {
  reloadDescription,
  setDescribing,
  setDescription,
  useDescribing,
} from "./descriptionsStore";

/// The two parameters `describe_clip` offers a human, at the values an omitted
/// argument resolves to in Rust.
///
/// TWIN of `DescribeClipArgs`' `unwrap_or(1.0)` and `Focus::parse(None)`
/// (`native/src/mcp/tools.rs`), and knowingly so — the addon exposes no getter
/// for them the way it does for the shot detector's (`shot_default_opts`).
/// Change one side and change this one: these two values are also the key of
/// the DEFAULT view, the only one `media://{id}/description` serves, so a
/// mismatch here would produce descriptions the shot rows can never read back.
///
/// Stated once and read from nowhere else in this module, so the field, the
/// remembered-view sentence and the request cannot disagree about what
/// "default" means.
const DEFAULT_FPS = 1.0;
const DEFAULT_FOCUS: DescribeFocus = "general";

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
function isNoBackendConfigured(err: unknown): boolean {
  return /no video-understanding backend/.test(String(err));
}

/// Describe one clip's content with a vision model, then read the result on the
/// shot rows.
///
/// TWO fields, both straight from the tool's own parameter set: how densely to
/// sample frames, and what to bias the tags toward. The window is not offered —
/// it defaults to the clip's endpoints, and a human who wants a shorter one
/// trims or splits the clip, which is the gesture this editor already has.
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

  const mediaId = target?.mediaId ?? null;
  const running = mediaId !== null && describing === mediaId;

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

  const atDefaultView = fps === DEFAULT_FPS && focus === DEFAULT_FOCUS;

  const submit = async () => {
    if (running) return;
    setError("");
    setNeedsBackend(false);
    setDescribing(target.mediaId);
    // Twenty seconds against a local model, so the run announces itself:
    // without a Started row the status badge has nothing to spin on and the
    // user cannot tell a slow engine from a dead one. One `op_id` pairs it with
    // the terminal row (docs/status-log.md).
    const opId = crypto.randomUUID();
    void logEmit({
      level: "info",
      category: { kind: "Project" },
      source: { kind: "User" },
      message: `Describing ${target.layerName}`,
      i18n_key: "log.describe_started",
      i18n_args: { clip: target.layerName },
      op_id: opId,
      op_state: { state: "Started" },
    });
    try {
      // Omitted at the defaults so Rust's own decide (`ipc/index.ts` states the
      // rule) — which is also what keeps a default run landing in the view the
      // shot rows read back.
      const result = await describeClip({
        layerId: target.layerId,
        ...(fps === DEFAULT_FPS ? {} : { fps }),
        ...(focus === DEFAULT_FOCUS ? {} : { focus }),
      });
      setDescribing(null);
      // The run's own segments first, so the column fills the moment the model
      // is done. Then, at the default view only, the cache behind them: it
      // holds every window of this source ever described, so the re-read is
      // how a row picks up prose an earlier run on a neighbouring clip
      // produced. A finer or re-focused run has no such view to re-read, and
      // asking for one would answer with the default view's segments — over
      // the top of the ones just computed.
      setDescription(target.mediaId, result.segments);
      if (atDefaultView) void reloadDescription(target.mediaId);
      void logEmit({
        level: "info",
        category: { kind: "Project" },
        source: { kind: "User" },
        message: `${result.segments.length} described spans in ${target.layerName} (${result.backend}, ${result.model})`,
        i18n_key: "log.describe_done",
        i18n_args: {
          clip: target.layerName,
          segments: result.segments.length,
          engine: result.backend,
          model: result.model,
        },
        op_id: opId,
        op_state: { state: "Ok" },
      });
      closeDescribePrompt();
      onRevealShots();
    } catch (err) {
      // The tool's own message, verbatim: "no backend available" names the two
      // ways to configure one, an explicit engine names the path it is missing,
      // and a speed refusal names the split to make. A generic "description
      // failed" would throw away the only actionable half.
      setError(refusalText(err));
      setNeedsBackend(isNoBackendConfigured(err));
      // Under the run's own `op_id`, or the Started row above never closes and
      // the status bar keeps a description spinning that has already failed.
      logMutationFailure(err, "describe_clip", opId);
      setDescribing(null);
    }
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
