// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

function installApi(listFamilies: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, "api", { configurable: true, value: { font: { listFamilies } } });
}

describe("font family request cache", () => {
  it("coalesces concurrent consumers and later remounts into one IPC per index revision", async () => {
    vi.resetModules();
    const listFamilies = vi.fn().mockResolvedValue(["Example Sans"]);
    installApi(listFamilies);
    const { getFontFamilies } = await import("./fontFamilies");
    const first = getFontFamilies(1);
    expect(getFontFamilies(1)).toBe(first);
    expect(await first).toEqual(["Example Sans"]);
    await getFontFamilies(1);
    expect(listFamilies).toHaveBeenCalledTimes(1);
  });

  it("refetches when the face index changes, since a project or the system scan adds families", async () => {
    vi.resetModules();
    const listFamilies = vi.fn().mockResolvedValueOnce(["Example Sans"]).mockResolvedValue(["Example Sans", "Project Serif"]);
    installApi(listFamilies);
    const { getFontFamilies } = await import("./fontFamilies");
    expect(await getFontFamilies(1)).toEqual(["Example Sans"]);
    expect(await getFontFamilies(2)).toEqual(["Example Sans", "Project Serif"]);
  });

  it("retries after IPC rejection", async () => {
    vi.resetModules();
    const listFamilies = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue(["Example Sans"]);
    installApi(listFamilies);
    const { getFontFamilies } = await import("./fontFamilies");
    await expect(getFontFamilies(1)).rejects.toThrow("disconnected");
    expect(await getFontFamilies(1)).toEqual(["Example Sans"]);
    expect(listFamilies).toHaveBeenCalledTimes(2);
  });
});
