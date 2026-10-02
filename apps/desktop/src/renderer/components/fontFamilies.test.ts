// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

describe("font family request cache", () => {
  it("coalesces concurrent consumers and later remounts into one IPC", async () => {
    vi.resetModules();
    const listFamilies = vi.fn().mockResolvedValue(["Example Sans"]);
    Object.defineProperty(window, "api", { configurable: true, value: { font: { listFamilies } } });
    const { getSystemFontFamilies } = await import("./fontFamilies");
    const first = getSystemFontFamilies();
    expect(getSystemFontFamilies()).toBe(first);
    expect(await first).toEqual(["Example Sans"]);
    await getSystemFontFamilies();
    expect(listFamilies).toHaveBeenCalledTimes(1);
  });

  it("retries after IPC rejection", async () => {
    vi.resetModules();
    const listFamilies = vi.fn().mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue(["Example Sans"]);
    Object.defineProperty(window, "api", { configurable: true, value: { font: { listFamilies } } });
    const { getSystemFontFamilies } = await import("./fontFamilies");
    await expect(getSystemFontFamilies()).rejects.toThrow("disconnected");
    expect(await getSystemFontFamilies()).toEqual(["Example Sans"]);
    expect(listFamilies).toHaveBeenCalledTimes(2);
  });
});
