import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  settingsGetVlmBackends,
  settingsSetVlmDescribe,
  settingsSetVlmPreferred,
  settingsSetVlmLocal,
  settingsClearVlmLocal,
  settingsSetVlmEndpoint,
  type VlmBackendInfo,
  type VlmBackendsView,
  type VlmDescribeFocus,
  type VlmPreferredEngine,
} from "../ipc";
import {
  VLM_DESCRIBE_FOCUSES,
  VLM_DESCRIBE_FPS_MAX,
  VLM_DESCRIBE_FPS_MIN,
  VLM_DESCRIBE_FPS_STEP,
} from "../../shared/vlm-config";
import { onDescribeViewChanged } from "../search/searchIndexStore";
import { open as openFileDialog } from "@/bridge/dialog";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { Button } from "@/components/ui/button";
import { ManagedContent } from "./ManagedContent";
import { vlmEngineOptions } from "./vlmEngineOptions";

/// Each focus value with its label key. A `Record` over the union so a third
/// focus cannot be added without writing the copy that names it.
const FOCUS_LABELS: Record<VlmDescribeFocus, string> = {
  general: "settings.vlm_focus_general",
  "shot-type": "settings.vlm_focus_shot_type",
};

/// Settings → Video understanding. The structural twin of `SpeechSection`:
/// fetch the full backend listing (preference + live availability, merged with
/// the TS-owned config store), render the engine selector, then one row per
/// backend BY LOCALITY. Self-fetches on mount and re-fetches after any mutation
/// so the badges and the "active engine" line stay live.
///
/// Two localities, and the endpoint one is the reason this is its own section
/// rather than more rows under Transcription: an OpenAI-compatible endpoint is a
/// first-class way to run a VLM, and it configures a URL, not a file. It is also
/// the only networked row — there is no hosted-provider backend to give a row of
/// its own, because pointing this one at a provider's URL IS that case. The
/// section shares no config with Transcription, not even a key.
export function VlmSection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<VlmBackendsView | null>(null);

  const refresh = async () => {
    try {
      setView(await settingsGetVlmBackends());
    } catch (e) {
      onError(String(e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Local draft for the sampling field, so a persist costs one IPC per EDIT
  // rather than one per keystroke (`AppNumberField` commits on blur / Enter /
  // step-end). Re-mirrored from the store after every commit, which is how the
  // clamp becomes visible: type 60 and the field comes back 30.
  const [fpsDraft, setFpsDraft] = useState<number | null>(null);
  useEffect(() => {
    if (view !== null) setFpsDraft(view.describe_fps);
  }, [view]);

  /// Re-fetch, then drop every description the renderer is holding and read them
  /// again — what EVERY mutation in this section owes, because every one of them
  /// moves the description cache key. The engine and its model label are hashed
  /// into that key exactly as the sampling and the focus are (`vlm::cache_key`),
  /// so picking another engine, or pointing one at a different GGUF, switches
  /// which cached view a read resolves just as surely as changing the sampling
  /// does. Without this the rows go on showing the previous view's prose — the
  /// same failure `resyncDescriptionsForView` was added for, on the axes it was
  /// not yet wired to.
  ///
  /// AFTER the persist, never before: the re-read resolves whatever main has
  /// stored, so a resync racing the write would re-read the view being left.
  const refreshAfterMutation = async () => {
    await refresh();
    onDescribeViewChanged();
  };

  /// Persist one or both run params, then re-fetch — the mutate-then-refresh
  /// cycle every other control in this section uses, so what renders is always
  /// the store's value and never a draft that could disagree with the clamp.
  const saveDescribe = async (patch: {
    fps?: number;
    focus?: VlmDescribeFocus;
  }) => {
    onError("");
    try {
      await settingsSetVlmDescribe(patch);
      await refreshAfterMutation();
    } catch (e) {
      onError(String(e));
    }
  };

  if (view === null) {
    return (
      <section className="settings-section">
        <p className="settings-status">…</p>
      </section>
    );
  }

  // The backend the resolver would use right now (null → nothing configured).
  const active = view.backends.find((b) => b.selected) ?? null;

  return (
    <>
      <section className="settings-section">
        <p className="settings-blurb">{t("settings.vlm_blurb")}</p>
        <label className="settings-toggle-row">
          <AppSelect
            value={view.preferred_engine}
            onValueChange={async (next) => {
              onError("");
              try {
                await settingsSetVlmPreferred(next as VlmPreferredEngine);
                await refreshAfterMutation();
              } catch (e) {
                onError(String(e));
              }
            }}
            options={vlmEngineOptions(t, view.backends)}
            ariaLabel={t("settings.vlm_engine")}
          />
          <span>
            <span className="settings-toggle-label">
              {t("settings.vlm_engine")}
            </span>
            <span className="settings-toggle-hint">
              {active
                ? t("settings.vlm_engine_active", { engine: active.label })
                : t("settings.vlm_engine_none")}
            </span>
          </span>
        </label>
        {/* The privacy rule is a property of the resolver, not of this panel,
            but it is the one thing a user picking an engine needs to know
            before they pick — so it is stated where the choice is made. */}
        <p className="settings-toggle-hint">{t("settings.vlm_privacy_note")}</p>
      </section>
      {/* The two run parameters, in their own group between the engine choice
          and the per-backend rows: the selector above decides WHICH engine, and
          these decide what it is asked to do. Not per-backend rows, because they
          apply to whichever engine resolves. */}
      <section className="settings-section">
        <label className="settings-toggle-row">
          <AppNumberField
            value={fpsDraft ?? view.describe_fps}
            onValueChange={setFpsDraft}
            onCommit={(v) => void saveDescribe({ fps: v })}
            min={VLM_DESCRIBE_FPS_MIN}
            max={VLM_DESCRIBE_FPS_MAX}
            step={VLM_DESCRIBE_FPS_STEP}
            format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
            align="center"
            className="settings-input-narrow"
            ariaLabel={t("settings.vlm_sampling")}
          />
          <span>
            <span className="settings-toggle-label">
              {t("settings.vlm_sampling")}
            </span>
            <span className="settings-toggle-hint">
              {t("settings.vlm_sampling_hint")}
            </span>
          </span>
        </label>
        <label className="settings-toggle-row">
          <AppSelect
            value={view.describe_focus}
            onValueChange={(next) =>
              void saveDescribe({ focus: next as VlmDescribeFocus })
            }
            options={VLM_DESCRIBE_FOCUSES.map((value) => ({
              value,
              label: t(FOCUS_LABELS[value]),
            }))}
            ariaLabel={t("settings.vlm_focus")}
          />
          <span>
            <span className="settings-toggle-label">
              {t("settings.vlm_focus")}
            </span>
            <span className="settings-toggle-hint">
              {t("settings.vlm_focus_hint")}
            </span>
          </span>
        </label>
        {/* What changing either of these actually does. Said here because this
            is where it is done, and said by VIEW rather than by these two
            fields: the engine, the model and the interface language key the same
            cache, and a sentence naming only the two controls beside it would
            leave a language switch looking like lost data. */}
        <p className="settings-toggle-hint">{t("settings.vlm_view_note")}</p>
      </section>
      <section className="settings-section">
        {view.backends.map((b) =>
          b.locality === "local" ? (
            <VlmLocalRow
              key={b.backend}
              info={b}
              onChanged={refreshAfterMutation}
              onError={onError}
            />
          ) : (
            <VlmEndpointRow
              key={b.backend}
              info={b}
              onChanged={refreshAfterMutation}
              onError={onError}
            />
          ),
        )}
      </section>
    </>
  );
}

/// Localized label for an availability verdict → the row's badge text.
function availabilityLabel(
  t: ReturnType<typeof useTranslation>["t"],
  a: VlmBackendInfo["availability"],
): string {
  switch (a) {
    case "available":
      return t("settings.vlm_available");
    case "needs_binary":
      return t("settings.vlm_needs_binary");
    case "needs_model":
      return t("settings.vlm_needs_model");
    case "needs_endpoint":
      return t("settings.vlm_needs_endpoint");
  }
}

function AvailabilityBadge({ info }: { info: VlmBackendInfo }) {
  const { t } = useTranslation();
  return (
    <span
      className={
        info.availability === "available"
          ? "settings-badge settings-badge-on"
          : "settings-badge settings-badge-off"
      }
    >
      {availabilityLabel(t, info.availability)}
    </span>
  );
}

/// One LOCAL engine's config row: the three paths vision needs — the
/// `llama-mtmd-cli` binary, the model GGUF, and its `mmproj` projector — plus an
/// optional device hint, Save / Clear, and the managed-download affordance.
///
/// No Test button, unlike `LocalBackendRow`. `settings_test_provider` probes a
/// SPEECH backend tag, and for a local speech engine that probe is file-presence
/// only — exactly what the availability badge above already reports from the
/// same check. A Test here would restate the badge; a real liveness spawn is a
/// different feature.
function VlmLocalRow({
  info,
  onChanged,
  onError,
}: {
  info: VlmBackendInfo;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [binary, setBinary] = useState(info.local?.binary ?? "");
  const [model, setModel] = useState(info.local?.model ?? "");
  const [mmproj, setMmproj] = useState(info.local?.mmproj ?? "");
  const [device, setDevice] = useState(info.local?.device ?? "");
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [flash, setFlash] = useState<"saved" | "cleared" | null>(null);

  // Resync the edit buffers when the upstream stored config changes — after a
  // Save round-trip re-fetches, a Clear, or a managed download's auto-fill.
  useEffect(() => {
    setBinary(info.local?.binary ?? "");
    setModel(info.local?.model ?? "");
    setMmproj(info.local?.mmproj ?? "");
    setDevice(info.local?.device ?? "");
  }, [info.local?.binary, info.local?.model, info.local?.mmproj, info.local?.device]);

  const browse = async (which: "binary" | "model" | "mmproj") => {
    onError("");
    try {
      const picked = await openFileDialog({
        title:
          which === "binary"
            ? t("settings.vlm_pick_binary")
            : which === "model"
              ? t("settings.vlm_pick_model")
              : t("settings.vlm_pick_mmproj"),
      });
      if (typeof picked === "string") {
        if (which === "binary") setBinary(picked);
        else if (which === "model") setModel(picked);
        else setMmproj(picked);
      }
    } catch (e) {
      onError(String(e));
    }
  };

  // All three are required: a GGUF without its projector is text-only, and the
  // availability probe reports NeedsModel for it — so saving a two-of-three
  // entry would only produce a row that says it is not ready.
  const canSave =
    binary.trim() !== "" && model.trim() !== "" && mmproj.trim() !== "";

  const save = async () => {
    if (!canSave) return;
    setBusy("save");
    onError("");
    try {
      await settingsSetVlmLocal({
        backend: info.backend,
        binary: binary.trim(),
        model: model.trim(),
        mmproj: mmproj.trim(),
        ...(device.trim() !== "" ? { device: device.trim() } : {}),
      });
      setFlash("saved");
      window.setTimeout(() => setFlash(null), 1500);
      await onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy("clear");
    onError("");
    try {
      await settingsClearVlmLocal(info.backend);
      setFlash("cleared");
      window.setTimeout(() => setFlash(null), 1500);
      await onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const pathRow = (
    labelKey: string,
    placeholderKey: string,
    value: string,
    setValue: (v: string) => void,
    which: "binary" | "model" | "mmproj",
  ) => (
    <div className="settings-key-input-row">
      <span className="settings-slider-label">{t(labelKey)}</span>
      <AppInput
        mono
        spellCheck={false}
        value={value}
        placeholder={t(placeholderKey)}
        disabled={busy !== null}
        onValueChange={setValue}
        ariaLabel={t(labelKey)}
      />
      <Button
        size="sm"
        onClick={() => void browse(which)}
        disabled={busy !== null}
      >
        {t("settings.speech_browse")}
      </Button>
    </div>
  );

  return (
    <div className="settings-key-row">
      <div className="settings-key-header">
        <span className="settings-key-label">{info.label}</span>
        <AvailabilityBadge info={info} />
      </div>
      {pathRow(
        "settings.vlm_binary",
        "settings.vlm_binary_placeholder",
        binary,
        setBinary,
        "binary",
      )}
      {pathRow(
        "settings.vlm_model",
        "settings.vlm_model_placeholder",
        model,
        setModel,
        "model",
      )}
      {pathRow(
        "settings.vlm_mmproj",
        "settings.vlm_mmproj_placeholder",
        mmproj,
        setMmproj,
        "mmproj",
      )}
      <div className="settings-key-input-row">
        <span className="settings-slider-label">{t("settings.speech_device")}</span>
        <AppInput
          spellCheck={false}
          value={device}
          placeholder={t("settings.speech_device_placeholder")}
          disabled={busy !== null}
          onValueChange={setDevice}
          ariaLabel={t("settings.speech_device")}
        />
      </div>
      <div className="settings-key-input-row">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={busy !== null || !canSave}
        >
          {busy === "save"
            ? t("settings.saving")
            : flash === "saved"
              ? t("settings.saved")
              : t("settings.save")}
        </Button>
        <Button
          size="sm"
          onClick={() => void clear()}
          disabled={busy !== null || info.local === undefined}
        >
          {busy === "clear"
            ? t("settings.clearing")
            : flash === "cleared"
              ? t("settings.cleared")
              : t("settings.clear")}
        </Button>
      </div>
      {/* ADR 0055: app-managed engine + model downloads. Renders nothing for
          backends without catalog coverage on this platform; installed paths
          land in the pickers above via the main-process auto-fill → onChanged
          re-fetch (this row's useEffect resync), never via these buffers. */}
      <ManagedContent
        family="vlm"
        backend={info.backend}
        onChanged={onChanged}
        onError={onError}
      />
    </div>
  );
}

/// The endpoint row: a full `/v1/chat/completions` URL, the model name the server
/// serves, and an optional key — blank for most self-hosted servers, required by
/// a hosted provider.
///
/// The key is write-only here. Main puts it in safeStorage and never echoes it
/// back, so the field shows an "already set" placeholder and an untouched field
/// leaves the stored key alone — the same contract as the Transcription key
/// inputs, for the same reason.
function VlmEndpointRow({
  info,
  onChanged,
  onError,
}: {
  info: VlmBackendInfo;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(info.endpoint?.url ?? "");
  const [model, setModel] = useState(info.endpoint?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [flash, setFlash] = useState<"saved" | "cleared" | null>(null);

  useEffect(() => {
    setUrl(info.endpoint?.url ?? "");
    setModel(info.endpoint?.model ?? "");
    setApiKey("");
  }, [info.endpoint?.url, info.endpoint?.model, info.endpoint?.has_api_key]);

  const save = async () => {
    if (url.trim() === "") return;
    setBusy("save");
    onError("");
    try {
      await settingsSetVlmEndpoint({
        url: url.trim(),
        ...(model.trim() !== "" ? { model: model.trim() } : {}),
        // Untouched → omit → main keeps the stored key.
        ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey("");
      setFlash("saved");
      window.setTimeout(() => setFlash(null), 1500);
      await onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy("clear");
    onError("");
    try {
      await settingsSetVlmEndpoint({ url: "" });
      setFlash("cleared");
      window.setTimeout(() => setFlash(null), 1500);
      await onChanged();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-key-row">
      <div className="settings-key-header">
        <span className="settings-key-label">{info.label}</span>
        <AvailabilityBadge info={info} />
      </div>
      <div className="settings-key-input-row">
        <span className="settings-slider-label">{t("settings.vlm_endpoint_url")}</span>
        <AppInput
          mono
          spellCheck={false}
          value={url}
          placeholder={t("settings.vlm_endpoint_url_placeholder")}
          disabled={busy !== null}
          onValueChange={setUrl}
          ariaLabel={t("settings.vlm_endpoint_url")}
        />
      </div>
      <div className="settings-key-input-row">
        <span className="settings-slider-label">{t("settings.vlm_endpoint_model")}</span>
        <AppInput
          mono
          spellCheck={false}
          value={model}
          placeholder={t("settings.vlm_endpoint_model_placeholder")}
          disabled={busy !== null}
          onValueChange={setModel}
          ariaLabel={t("settings.vlm_endpoint_model")}
        />
      </div>
      <div className="settings-key-input-row">
        <span className="settings-slider-label">{t("settings.vlm_endpoint_key")}</span>
        <AppInput
          type="password"
          mono
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          placeholder={
            info.endpoint?.has_api_key
              ? t("settings.placeholder_set")
              : t("settings.vlm_endpoint_key_placeholder")
          }
          disabled={busy !== null}
          onValueChange={setApiKey}
          ariaLabel={t("settings.vlm_endpoint_key")}
        />
      </div>
      <div className="settings-key-input-row">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={busy !== null || url.trim() === ""}
        >
          {busy === "save"
            ? t("settings.saving")
            : flash === "saved"
              ? t("settings.saved")
              : t("settings.save")}
        </Button>
        <Button
          size="sm"
          onClick={() => void clear()}
          disabled={busy !== null || info.endpoint === undefined}
        >
          {busy === "clear"
            ? t("settings.clearing")
            : flash === "cleared"
              ? t("settings.cleared")
              : t("settings.clear")}
        </Button>
      </div>
    </div>
  );
}

