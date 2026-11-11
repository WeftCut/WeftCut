import type { TFunction } from "i18next";
import { rendererOS, type RendererOS } from "../platform";

/// The plain-language reason a write of project.json failed, from its errno
/// code. EPERM is Windows' answer when another program holds the file open
/// (a scanner, a sync client); elsewhere it is a permission refusal.
export function saveFailureReasonKey(code: string | null, os: RendererOS = rendererOS): string {
  switch (code) {
    case "ENOSPC": return "save_status.reason.disk_full";
    case "EACCES": return "save_status.reason.no_permission";
    case "EPERM": return os === "windows" ? "save_status.reason.in_use" : "save_status.reason.no_permission";
    case "EBUSY": return "save_status.reason.in_use";
    case "ENOENT": return "save_status.reason.folder_missing";
    case "EROFS": return "save_status.reason.read_only";
    case null: return "save_status.reason.unknown";
    default: return "save_status.reason.other";
  }
}

export function saveFailureReason(t: TFunction, code: string | null, os: RendererOS = rendererOS): string {
  return t(saveFailureReasonKey(code, os), { code: code ?? "" });
}

/// "Last saved 14:32:05", or that this project has not been saved since it
/// was opened.
export function lastSavedText(t: TFunction, lastSavedAt: string | null): string {
  if (lastSavedAt === null) return t("save_status.never_saved");
  const time = new Date(lastSavedAt).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  return t("save_status.last_saved", { time });
}
