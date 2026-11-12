import { describe, expect, it } from "vitest";
import { classifyOS, modKeyHeld, modKeyLabel } from "./platform";

// Real (platform, userAgent) pairs Electron's Chromium reports per OS. The
// classifier feeds platform-gated policies (export HW-decode allowlist), so a
// misclassification silently flips a decode path — pin the matrix.
describe("classifyOS", () => {
  it("classifies Windows from navigator.platform", () => {
    expect(classifyOS("Win32", "")).toBe("windows");
  });

  it("classifies Windows from the userAgent fallback", () => {
    expect(
      classifyOS("", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/1 Electron/44"),
    ).toBe("windows");
  });

  it("classifies macOS from navigator.platform", () => {
    expect(classifyOS("MacIntel", "")).toBe("mac");
  });

  it("classifies macOS from the userAgent fallback", () => {
    expect(
      classifyOS("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/1"),
    ).toBe("mac");
  });

  it("classifies Linux", () => {
    expect(classifyOS("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64) Chrome/1")).toBe(
      "linux",
    );
  });

  it("falls back to linux (the conservative verdict) for unrecognized signals", () => {
    expect(classifyOS("", "")).toBe("linux");
    expect(classifyOS("FreeBSD amd64", "Mozilla/5.0 (X11; FreeBSD)")).toBe("linux");
  });
});

// Mod is the bypass key for gestures as well as the shortcut modifier. On macOS
// a Ctrl+press is the system's context-menu click, so only ⌘ may count there.
describe("modKeyHeld", () => {
  it("reads ⌘ on macOS and leaves a bare Ctrl to the context menu", () => {
    expect(modKeyHeld({ ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(modKeyHeld({ ctrlKey: true, metaKey: false }, true)).toBe(false);
    expect(modKeyLabel(true)).toBe("⌘");
  });

  it("reads Ctrl elsewhere", () => {
    expect(modKeyHeld({ ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(modKeyHeld({ ctrlKey: false, metaKey: true }, false)).toBe(false);
    expect(modKeyLabel(false)).toBe("Ctrl");
  });
});
