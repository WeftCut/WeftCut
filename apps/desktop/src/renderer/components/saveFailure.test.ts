import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { saveFailureReason, saveFailureReasonKey } from "./saveFailure";

describe("saveFailureReasonKey", () => {
  it.each([
    ["ENOSPC", "linux", "disk_full"],
    ["EACCES", "windows", "no_permission"],
    ["EPERM", "windows", "in_use"],
    ["EPERM", "mac", "no_permission"],
    ["EPERM", "linux", "no_permission"],
    ["EBUSY", "linux", "in_use"],
    ["ENOENT", "mac", "folder_missing"],
    ["EROFS", "linux", "read_only"],
    ["EIO", "windows", "other"],
    [null, "windows", "unknown"],
  ] as const)("%s on %s reads as %s", (code, os, reason) => {
    expect(saveFailureReasonKey(code, os)).toBe(`save_status.reason.${reason}`);
  });

  it("names the code when no plain reason fits, in both locales", async () => {
    for (const lng of ["en-US", "zh-CN"]) {
      await i18n.changeLanguage(lng);
      expect(saveFailureReason(i18n.t, "EIO", "linux")).toContain("EIO");
    }
  });
});
