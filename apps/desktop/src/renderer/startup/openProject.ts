// Open project, on the start screen and in the File menu (ADR 0180): one file
// picker for a project file or a pack. A project file opens its folder in
// place; a pack is first unpacked into a new folder the user places. A file
// the OS hands the app (ADR 0181) takes the same path past the picker.

import type { TFunction } from "i18next";
import { open as openDialog } from "@/bridge/dialog";
import { projectOpen } from "../ipc";
import { notify, unpackProject } from "../pack/packJobs";
import { describeOpenError } from "./openError";
import { LEGACY_PROJECT_FILE, PACK_EXTENSION, PROJECT_EXTENSION } from "../../shared/projectFile";

/// Asks for a project file or a pack and opens it (`openProjectFile`).
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
  return openProjectFile(t, picked, opened);
}

/// Opens a project file or a pack the user chose. A project file opens in
/// place and `opened` runs, unless it is the project already open, which main
/// leaves as it is; an unpacked pack opens through main, which tells the
/// window itself (`project:opened`). Answers what to show when it did not
/// open, null when it opened or the user cancelled.
export async function openProjectFile(t: TFunction, file: string, opened: () => void): Promise<string | null> {
  if (file.toLowerCase().endsWith(`.${PACK_EXTENSION}`)) return unpackProject(t, file);
  try {
    if ((await projectOpen(file, true)).already_open) return null;
  } catch (err) {
    return describeOpenError(err, file, t);
  }
  opened();
  return null;
}

/// The same flow from the editor, its refusal as a notice: through the picker,
/// or for `file` the OS handed over. `replaced` remounts the editor on the
/// project now open, as `project:opened` does.
export async function openProjectFromEditor(t: TFunction, replaced: () => void, file?: string): Promise<void> {
  const problem = await (file === undefined ? openProject(t, replaced) : openProjectFile(t, file, replaced));
  if (problem !== null) notify({ id: "open-project", outcome: "error", title: t("open_project.failed_title"), body: problem });
}
