import type { AppNotice } from "../../shared/ipc";

export type SystemSettingsTarget = "general" | "speech" | "agent";

export function systemSettingsTarget(code: string): SystemSettingsTarget | null {
  if (code === "native_decode_unavailable") return "general";
  if (code === "keyring_unavailable") return "speech";
  if (code === "agent_skill_unavailable" || code === "agent_skill_stale") {
    return "agent";
  }
  return null;
}

/// Canonical English text for the persistent log. The current-status panel is
/// localized independently; JSONL stays searchable and stable across locales.
export function systemNoticeLogMessage(notice: AppNotice): string {
  if (notice.code === "native_decode_unavailable") {
    return "Native decode engine unavailable; preview is using WebCodecs.";
  }
  if (notice.code === "keyring_unavailable") {
    return "OS keyring unavailable; cloud API keys may be stored unencrypted.";
  }
  if (notice.code === "agent_skill_unavailable") {
    return "Agent skill not installed; the Agent panel has no skill folder to offer.";
  }
  if (notice.code === "agent_skill_stale") {
    return "Agent skill refresh failed; the offered folder is an earlier version's copy.";
  }
  return `System capability notice: ${notice.code}`;
}
