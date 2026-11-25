// Pack project and unpack from the renderer (ADR 0178): the two
// flows, how the running one reads, and what a refusal says. Main owns the run
// itself (`main/state/projectPack.ts`); one runs at a time, and
// `packJobStore.ts` mirrors it.

import type { TFunction } from "i18next";
import { open as openDialog } from "@/bridge/dialog";
import { sendNotification } from "@/bridge/notification";
import { formatBytes } from "../lib/formatBytes";
import { useComputeJobNoticeStore } from "../compute/computeJobNotices";
import { describeOpenError, cleanIpcDetail, parseWorkspaceError } from "../startup/openError";
import { projectPack, projectPackCancel, projectUnpack, projectUnpackInspect, type PackJobProgress } from "../ipc";
import { parsePackRefusal } from "../../shared/projectPack";

/// The run's percent, or undefined before its total is known.
export function packPercent(job: PackJobProgress): number | undefined {
  return job.total > 0 ? Math.min(100, Math.floor((job.done * 100) / job.total)) : undefined;
}

/// "1.2 GB of 3.0 GB".
export function packBytes(t: TFunction, job: PackJobProgress): string {
  return t("pack.bytes", { done: formatBytes(job.done), total: formatBytes(job.total) });
}

/// What the user reads for a pack or unpack that did not start or failed.
/// `path` is the pack file, or the folder an unpack writes.
export function describePackError(err: unknown, t: TFunction, kind: PackJobProgress["kind"], path: string): string {
  const refusal = parsePackRefusal(err);
  if (refusal) {
    switch (refusal.refusal) {
      case "PackBusy": return t("pack.busy");
      case "NoProjectOpen": return t("pack.no_project");
      case "NotAPack": return t("pack.not_a_pack", { detail: refusal.detail });
      case "FolderNotEmpty": return t("pack.folder_not_empty", { folder: refusal.folder });
      case "NotEnoughSpace":
        return t("pack.no_space", { needed: formatBytes(refusal.needed), available: formatBytes(refusal.available) });
    }
  }
  // The open's own refusals (a newer schema, an unreadable project.wcpr).
  if (parseWorkspaceError(err)) return describeOpenError(err, path, t);
  return t(kind === "pack" ? "pack.pack_failed" : "pack.unpack_failed", { detail: cleanIpcDetail(err) });
}

/// Posts to the app's one notice slot (`compute/computeJobNotices.ts`), and
/// to the OS while the window is unfocused.
export function notify(notice: { id: string; outcome: "ok" | "error"; title: string; body: string; reveal?: string }): void {
  const { id, reveal, ...rest } = notice;
  useComputeJobNoticeStore.setState({ notice: { jobId: id, ...rest, ...(reveal ? { reveal } : {}) } });
  if (!document.hasFocus()) sendNotification({ title: notice.title, body: notice.body });
}

/// Packs the open project into `archive`. Resolves once the pack is complete,
/// cancelled or failed, each but the cancel told by a notice.
export async function runPack(t: TFunction, archive: string): Promise<void> {
  try {
    const result = await projectPack(archive);
    if (result.outcome === "done") {
      notify({ id: `pack:${archive}`, outcome: "ok", title: t("pack.done_title"), body: result.archive, reveal: result.archive });
    }
  } catch (err) {
    notify({ id: `pack:${archive}`, outcome: "error", title: t("pack.failed_title"), body: describePackError(err, t, "pack", archive) });
  }
}

export function cancelPackJob(): void {
  void projectPackCancel().catch((err: unknown) => console.warn("[pack] cancel failed", err));
}

/// The pack half of Open project (`startup/openProject.ts`): `archive` is read
/// before anything is written, then the user picks the folder to unpack it
/// in. The project opens through main, which tells the window as an agent's
/// open does. Answers what to show when it did not open, null when it opened
/// or the user cancelled.
export async function unpackProject(t: TFunction, archive: string): Promise<string | null> {
  let folder: string;
  try {
    folder = (await projectUnpackInspect(archive)).folder_name;
  } catch (err) {
    return describePackError(err, t, "unpack", archive);
  }
  const parent = await openDialog({ title: t("pack.parent_title", { folder }), directory: true });
  if (typeof parent !== "string") return null;
  try {
    await projectUnpack(archive, parent);
    return null;
  } catch (err) {
    return describePackError(err, t, "unpack", folder);
  }
}
