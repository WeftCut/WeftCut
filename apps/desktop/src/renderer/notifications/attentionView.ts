// What the bell's notification center lists: the things that need the user and
// have no entry of their own in the bar. A dismissed item leaves the list; the
// state it points at stays where it lives (a settings page, Help · Check for
// Updates). Pure, so ordering, dismissal and the bell's severity are tested
// without a renderer. Layout and behaviour: `docs/status-log.md` §
// Notification center.
//
// Save failed is deliberately absent: it has its own entry in the bar, and a
// second one here would be a duplicate way in.

import type { AppNotice, AppNoticeCode } from "../../shared/ipc";
import type { UpdateStatus } from "../../shared/updates";

export type AttentionLevel = AppNotice["level"];

export type AttentionItem =
  /// Unreviewed agent changes (ADR 0115). Gone once reviewed; never dismissed.
  | { kind: "review"; key: "review"; level: "info"; count: number }
  /// An environment notice from main (`app:notices`), at its own level.
  | { kind: "notice"; key: string; level: AttentionLevel; code: AppNoticeCode }
  /// An offered update the user has not skipped.
  | { kind: "update"; key: "update"; level: "info"; update: UpdateStatus & { version: string } };

export interface AttentionView {
  /// Not dismissed, most severe first.
  active: AttentionItem[];
  /// The bell's dot: the most severe item, `null` for no dot.
  level: AttentionLevel | null;
}

export interface AttentionInput {
  notices: readonly AppNotice[];
  /// Main-owned (app settings): a code stays dismissed while its notice
  /// stands; main forgets it once the notice is gone, so a return shows again.
  dismissedNotices: readonly string[];
  unreviewed: number;
  /// From `useNoticedUpdate`: offered and not skipped, else null. Skipping is
  /// the update's one dismissal, the same in the center and the update dialog.
  update: UpdateStatus | null;
}

const RANK: Record<AttentionLevel, number> = { error: 0, warn: 1, info: 2 };

export function attentionView(input: AttentionInput): AttentionView {
  const active: AttentionItem[] = [];
  for (const notice of input.notices) {
    if (input.dismissedNotices.includes(notice.code)) continue;
    active.push({ kind: "notice", key: `notice:${notice.code}`, level: notice.level, code: notice.code });
  }
  if (input.unreviewed > 0) {
    active.push({ kind: "review", key: "review", level: "info", count: input.unreviewed });
  }
  const update = input.update;
  if (update?.version) {
    active.push({ kind: "update", key: "update", level: "info", update: { ...update, version: update.version } });
  }
  // Stable: within a level, notices, then review, then the update.
  active.sort((a, b) => RANK[a.level] - RANK[b.level]);
  return { active, level: active[0]?.level ?? null };
}
