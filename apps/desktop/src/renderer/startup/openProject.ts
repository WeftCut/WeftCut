// Open project, on the start screen and in the File menu (ADR 0180): one file
// picker for a project file or a pack. A project file opens its folder in
// place; a pack is first unpacked into a new folder the user places.

import type { TFunction } from "i18next";
import { open as openDialog } from "@/bridge/dialog";
import { invoke } from "@/bridge/ipc";
import { projectOpen } from "../ipc";
import { notify, unpackProject } from "../pack/packJobs";
import { describeOpenError } from "./openError";
import { LEGACY_PROJECT_FILE, PACK_EXTENSION, PROJECT_EXTENSION, PROJECT_FILE } from "../../shared/projectFile";

/// Asks for a project file or a pack and opens it. A project file opens in
/// place and `opened` runs; an unpacked pack opens through main, which tells
/// the window itself (`project:opened`). Answers what to show when it did not
/// open, null when it opened or the user cancelled.
export async function openProject(t: TFunction, opened: () => void): Promise<string | null> {
  const picked = await openDialog({
    title: t("open_project.title"),
    filters: [
      { name: t("open_project.filter"), extensions: [PROJECT_EXTENSION, PACK_EXTENSION] },
      // A 0.8 project not in Recent: main takes only a file named
      // LEGACY_PROJECT_FILE, and renames it as it opens.
      { name: t("open_project.legacy_filter", { file: LEGACY_PROJECT_FILE }), extensions: ["json"] },
    ],
  });
  if (typeof picked !== "string") return null;
  if (picked.toLowerCase().endsWith(`.${PACK_EXTENSION}`)) return unpackProject(t, picked);
  // The project already open stays as it is: an open of its own folder
  // reloads it, which drops its undo history and checkpoints.
  const open = (await invoke<{ dir: string } | null>("project_open_state"))?.dir;
  if (open !== undefined && [`${open}/${PROJECT_FILE}`, `${open}\\${PROJECT_FILE}`].includes(picked)) return null;
  try {
    await projectOpen(picked);
  } catch (err) {
    return describeOpenError(err, picked, t);
  }
  opened();
  return null;
}

/// The same flow from the editor, its refusal as a notice. `replaced`
/// remounts the editor on the project now open, as `project:opened` does.
export async function openProjectFromEditor(t: TFunction, replaced: () => void): Promise<void> {
  const problem = await openProject(t, replaced);
  if (problem !== null) notify({ id: "open-project", outcome: "error", title: t("open_project.failed_title"), body: problem });
}
