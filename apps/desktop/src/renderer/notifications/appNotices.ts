// Environment notices: the states main collects at startup (and retracts after
// an in-app recovery) that the user should know about. One catalog per code —
// where its home is in Settings and its line in the persistent log — and one
// app-wide mirror of the current set, read by the bell, the notice's settings
// home and the editor's log mirror alike. The UI strings are
// `app_notice.<code>.title` / `.body`.
//
// The mirror is pulled once and then follows main's `app:notices` pushes: main
// collects notices before any window exists, so a push alone would be lost to
// the fire-before-subscribe race; a recovery (the agent Skill reinstall) has
// to retract its own notice after the pull.

import { useEffect } from "react";
import { create } from "zustand";
import type { AppNotice, AppNoticeCode } from "../../shared/ipc";

/// The Settings pages a notice can lead to.
export type NoticeSettingsPage = "general" | "speech" | "agent";

interface NoticeEntry {
  /// Where the state always shows and can be acted on, whether or not its
  /// bell row was dismissed (ADR 0166).
  page: NoticeSettingsPage;
  /// Canonical English for the persistent log: JSONL stays searchable and
  /// stable across locales.
  logMessage: string;
}

const NOTICES: Record<AppNoticeCode, NoticeEntry> = {
  native_decode_unavailable: {
    page: "general",
    logMessage: "Native decode engine unavailable; preview is using WebCodecs.",
  },
  keyring_unavailable: {
    page: "speech",
    logMessage: "OS keyring unavailable; cloud API keys may be stored unencrypted.",
  },
  agent_skill_unavailable: {
    page: "agent",
    logMessage: "Agent skill not installed; the Agent panel has no skill folder to offer.",
  },
  agent_skill_stale: {
    page: "agent",
    logMessage: "Agent skill refresh failed; the offered folder is an earlier version's copy.",
  },
};

/// The i18n key of each page's tab label, for copy that names the page.
export const NOTICE_PAGE_LABEL: Record<NoticeSettingsPage, string> = {
  general: "settings.cat_general",
  speech: "settings.cat_speech",
  agent: "settings.cat_agent",
};

export const noticeSettingsPage = (code: AppNoticeCode): NoticeSettingsPage => NOTICES[code].page;
export const noticeLogMessage = (code: AppNoticeCode): string => NOTICES[code].logMessage;

const NO_NOTICES: readonly AppNotice[] = [];

export const useAppNoticesStore = create<{ notices: readonly AppNotice[] }>(() => ({ notices: NO_NOTICES }));

/// The notices standing now, most recent list from main.
export const useAppNotices = (): readonly AppNotice[] => useAppNoticesStore((s) => s.notices);

/// Whether one notice stands: its settings home shows it while it does.
export const useAppNoticeStanding = (code: AppNoticeCode): boolean =>
  useAppNoticesStore((s) => s.notices.some((notice) => notice.code === code));

/// Keeps the mirror in step with main for as long as the caller is mounted.
/// The main window's root mounts it once, so the start screen's Settings and
/// the editor read the same set.
export function useAppNoticeEvents(): void {
  useEffect(() => {
    let alive = true;
    const receive = (notices: readonly AppNotice[]) => {
      if (alive) useAppNoticesStore.setState({ notices });
    };
    window.api.app
      .notices()
      .then(receive)
      // Best-effort: a failed pull must never block the editor.
      .catch(() => {});
    const off = window.api.on("app:notices", (payload) => receive(payload as AppNotice[]));
    return () => {
      alive = false;
      off();
    };
  }, []);
}

export function resetAppNoticesForTests(): void {
  useAppNoticesStore.setState({ notices: NO_NOTICES });
}
