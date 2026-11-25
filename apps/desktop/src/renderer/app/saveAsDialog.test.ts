import path from "node:path";
import { describe, expect, it } from "vitest";

import i18n from "../i18n";
import { saveAsDialogOptions } from "./saveAsDialog";

const t = i18n.t.bind(i18n);
const posix = async (...parts: string[]) => path.posix.join(...parts);
const win32 = async (...parts: string[]) => path.win32.join(...parts);

describe("saveAsDialogOptions", () => {
  it("offers a new folder beside the open one, named for the project, with no extension filter", async () => {
    const opts = await saveAsDialogOptions({ t, name: "My Film", openDir: "/home/u/Films/Cut", join: posix });
    expect(opts).toEqual({ title: t("dialogs.save_title"), defaultPath: "/home/u/Films/My Film copy" });
  });

  it("never offers the open folder itself when it is named after the project", async () => {
    const opts = await saveAsDialogOptions({ t, name: "My Film", openDir: "/home/u/Films/My Film", join: posix });
    expect(opts.defaultPath).not.toBe("/home/u/Films/My Film");
    expect(path.posix.dirname(opts.defaultPath!)).toBe("/home/u/Films");
  });

  it("composes the same path with Windows separators", async () => {
    const opts = await saveAsDialogOptions({ t, name: "My Film", openDir: "C:\\Users\\u\\Films\\Cut\\", join: win32 });
    expect(opts.defaultPath).toBe("C:\\Users\\u\\Films\\My Film copy");
  });

  it("keeps a name that would split into folders as one folder", async () => {
    const opts = await saveAsDialogOptions({ t, name: "Cut 1/2", openDir: "/home/u/Films/Cut", join: posix });
    expect(path.posix.dirname(opts.defaultPath!)).toBe("/home/u/Films");
  });

  it("falls back to the parent folder without a name, and to no path without a folder", async () => {
    expect(await saveAsDialogOptions({ t, name: undefined, openDir: "/home/u/Films/Cut", join: posix }))
      .toEqual({ title: t("dialogs.save_title"), defaultPath: "/home/u/Films" });
    expect((await saveAsDialogOptions({ t, name: "My Film", openDir: null, join: posix })).defaultPath).toBe("My Film copy");
    expect(await saveAsDialogOptions({ t, name: undefined, openDir: null, join: posix })).toEqual({ title: t("dialogs.save_title") });
  });
});
