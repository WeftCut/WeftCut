// Video-understanding engine selector options (Auto + one per known backend),
// the twin of speechEngineOptions.tsx. Data-driven from the backend listing so
// a new engine appears here the moment Rust's `VlmBackend::all()` grows one.
import type { TFunction } from "i18next";
import type { AppSelectOption } from "../components/AppSelect";
import type { VlmBackendInfo } from "../ipc";

/// Backends with no describer impl yet: shown for discoverability, but disabled
/// (choosing one has no effect). Empty today — every listed backend has a
/// working sidecar / HTTP impl.
const NOT_YET_SELECTABLE: ReadonlySet<string> = new Set();

export function vlmEngineOptions(
  t: TFunction,
  backends: readonly VlmBackendInfo[],
): AppSelectOption[] {
  const opts: AppSelectOption[] = [
    { value: "auto", label: t("settings.vlm_engine_auto") },
  ];
  for (const b of backends) {
    opts.push({
      value: b.backend,
      label: NOT_YET_SELECTABLE.has(b.backend)
        ? `${b.label} — ${t("settings.vlm_engine_soon")}`
        : b.label,
      disabled: NOT_YET_SELECTABLE.has(b.backend),
    });
  }
  return opts;
}
