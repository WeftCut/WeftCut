import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  settingsGetVlmBackends,
  settingsSetVlmPreferred,
  settingsSetVlmLocal,
  settingsClearVlmLocal,
  settingsSetVlmEndpoint,
  type VlmBackendInfo,
  type VlmBackendsView,
  type VlmPreferredEngine,
} from "../ipc";
import { open as openFileDialog } from "@/bridge/dialog";
import { AppInput } from "../components/AppInput";
import { AppSelect } from "../components/AppSelect";
import { Button } from "@/components/ui/button";
import { ManagedContent } from "./ManagedContent";
import { vlmEngineOptions } from "./vlmEngineOptions";

/// Settings → Video understanding. The structural twin of `SpeechSection`:
/// fetch the full backend listing (preference + live availability, merged with
/// the TS-owned config store), render the engine selector, then one row per
/// backend BY LOCALITY. Self-fetches on mount and re-fetches after any mutation
/// so the badges and the "active engine" line stay live.
///
/// Three localities where speech has two, and the third is the reason this is
/// its own section rather than more rows under Transcription: a self-hosted
/// OpenAI-compatible endpoint is a first-class way to run a VLM, and it
/// configures a URL, not a file.
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
                await refresh();
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
      <section className="settings-section">
        {view.backends.map((b) =>
          b.locality === "local" ? (
            <VlmLocalRow
              key={b.backend}
              info={b}
              onChanged={refresh}
              onError={onError}
            />
          ) : b.locality === "endpoint" ? (
            <VlmEndpointRow
              key={b.backend}
              info={b}
              onChanged={refresh}
              onError={onError}
            />
          ) : (
            <VlmCloudRow key={b.backend} info={b} />
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
    case "needs_key":
      return t("settings.vlm_needs_key");
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

/// The BYO endpoint row: a full `/v1/chat/completions` URL, the model name the
/// server serves, and an optional key for servers that want one.
///
/// The key is write-only here. Main persists it (a self-hosted server may
/// require one) but never echoes it back, so the field shows a "already set"
/// placeholder and an untouched field leaves the stored key alone — the same
/// contract as the cloud key inputs, for the same reason.
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

/// The cloud row is a STATUS row, not an editor. The cloud VLM rides the same
/// OpenAI key the Transcription section already manages (main merges it in), so
/// a second key field here would write the one secret from two places and let
/// them disagree on screen. It reports the shared key's effect and says where
/// to change it.
function VlmCloudRow({ info }: { info: VlmBackendInfo }) {
  const { t } = useTranslation();
  return (
    <div className="settings-key-row">
      <div className="settings-key-header">
        <span className="settings-key-label">{info.label}</span>
        <AvailabilityBadge info={info} />
      </div>
      <p className="settings-toggle-hint">{t("settings.vlm_cloud_shared_key")}</p>
    </div>
  );
}
