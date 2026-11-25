import type { TFunction } from "i18next";
import type { DialogSaveOpts } from "../../shared/ipc";
import { portableFileName } from "../../shared/projectPath";

export interface SaveAsDialogInput {
  t: TFunction;
  /// The open project's name; absent before its summary arrives.
  name: string | undefined;
  /// The open project's folder, or null with none open.
  openDir: string | null;
  /// Main's `path.join` (`@/bridge/path`), so the result follows the host's separators.
  join: (...parts: string[]) => Promise<string>;
}

/// File › Save As's dialog. The path it answers is the new project folder, so
/// there is no extension filter. It offers "<name> copy" beside the open
/// folder: New project names a folder after its project, so the bare name
/// would be the open folder itself. Main refuses a path that already exists
/// (`ProjectFolderExists`).
export async function saveAsDialogOptions({ t, name, openDir, join }: SaveAsDialogInput): Promise<DialogSaveOpts> {
  const title = t("dialogs.save_title");
  const folder = name ? portableFileName(t("dialogs.save_as_default_name", { name }), () => false) : null;
  const parts = [...(openDir ? [openDir, ".."] : []), ...(folder ? [folder] : [])];
  return parts.length > 0 ? { title, defaultPath: await join(...parts) } : { title };
}
