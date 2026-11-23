import { describe, expect, it } from "vitest";
import { formatFontStack, isFontSlot, singleFontFamily } from "./fontSlot";

describe("font slots", () => {
  it("are string props under the font_ key prefix", () => {
    expect(isFontSlot("font_headline", { type: "string", default: "serif" })).toBe(true);
    expect(isFontSlot("font_size", { type: "number", default: 12 })).toBe(false);
    expect(isFontSlot("title", { type: "string", default: "" })).toBe(false);
  });

  it("read back the one family a formatted stack names", () => {
    for (const family of ["Anton", "Source Serif 4", "O'Brien Sans", "Back\\slash"])
      expect(singleFontFamily(formatFontStack([family]))).toBe(family);
    expect(singleFontFamily('"Noto Sans SC"')).toBe("Noto Sans SC");
    expect(singleFontFamily("Impact")).toBe("Impact");
  });

  it("name no single family for a stack of several", () => {
    expect(singleFontFamily(formatFontStack(["Anton", "Impact"]))).toBeNull();
    expect(singleFontFamily("'Anton', sans-serif")).toBeNull();
    expect(singleFontFamily("")).toBeNull();
  });
});
