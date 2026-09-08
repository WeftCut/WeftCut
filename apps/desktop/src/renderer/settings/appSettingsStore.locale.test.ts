// @vitest-environment jsdom
//
// The language half of the boot wire-up, and only that half.
//
// It earns a file of its own because `app_settings.language` is no longer just
// a UI preference: Electron main injects it into `describe_clip` and into the
// `media://{id}/description` read, and it is part of the description cache key
// (`native/src/vlm/description.rs`). A boot that left the field unset while the
// UI ran in Chinese would have main looking for descriptions under a key nothing
// ever writes — a silent, permanent "Not described" on every shot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appSettingsGet: vi.fn(),
  appSettingsSet: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => ({
  ...(await importActual<typeof import("../ipc")>()),
  appSettingsGet: mocks.appSettingsGet,
  appSettingsSet: mocks.appSettingsSet,
}));
vi.mock("@/bridge/events", async (importActual) => ({
  ...(await importActual<typeof import("@/bridge/events")>()),
  listen: mocks.listen,
}));

import i18n from "../i18n";
import type { AppSettings } from "../ipc";
import { wireAppSettingsStream } from "./appSettingsStore";

const LEGACY_KEY = "weftcut.locale";

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return { ...(over as AppSettings) };
}

/// What main was asked to persist for `language`, or undefined if it was never
/// asked.
function persistedLanguage(): string | undefined {
  const call = mocks.appSettingsSet.mock.calls.find(
    (c) => (c[0] as { language?: string }).language !== undefined,
  );
  return (call?.[0] as { language?: string } | undefined)?.language;
}

describe("wireAppSettingsStream — the UI language", () => {
  beforeEach(async () => {
    mocks.appSettingsSet.mockReset().mockImplementation(async (patch) => settings(patch));
    mocks.listen.mockReset().mockResolvedValue(() => {});
    localStorage.clear();
    await i18n.changeLanguage("en-US");
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("applies a persisted language and writes nothing back", async () => {
    mocks.appSettingsGet.mockResolvedValue(settings({ language: "zh-CN" }));
    await wireAppSettingsStream();
    expect(i18n.resolvedLanguage).toBe("zh-CN");
    expect(persistedLanguage()).toBeUndefined();
  });

  // A first launch: the field used to stay unset, which meant main had nothing
  // to inject. It is now pinned to whatever the OS detection resolved to — and
  // nothing is taken away by that, because the language control is a TOGGLE over
  // the supported locales and never offers a "follow the system" position.
  it("pins the detected locale on a first launch", async () => {
    mocks.appSettingsGet.mockResolvedValue(settings({}));
    await i18n.changeLanguage("zh-CN");
    await wireAppSettingsStream();
    expect(persistedLanguage()).toBe("zh-CN");
  });

  // i18next resolves a region it has no resources for down to the bare code
  // (`nonExplicitSupportedLngs`), so the value on hand is often not itself a
  // member of `SUPPORTED_LOCALES` — it has to be matched on the primary subtag
  // rather than stored raw, or main would key the cache under `"zh"` while the
  // menu's toggle wrote `"zh-CN"`.
  it("pins a bare language code as the supported locale it means", async () => {
    mocks.appSettingsGet.mockResolvedValue(settings({}));
    await i18n.changeLanguage("zh");
    await wireAppSettingsStream();
    expect(persistedLanguage()).toBe("zh-CN");
  });

  // The legacy migration still wins over detection: an upgrading user's own
  // earlier choice is not a thing to overwrite with what the OS happens to say.
  it("prefers a legacy localStorage choice over the detected locale", async () => {
    mocks.appSettingsGet.mockResolvedValue(settings({}));
    localStorage.setItem(LEGACY_KEY, "zh-CN");
    await i18n.changeLanguage("en-US");
    await wireAppSettingsStream();
    expect(persistedLanguage()).toBe("zh-CN");
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  // A legacy value that is not a supported locale is not a choice — it is
  // garbage, and detection still has to produce an answer for main.
  it("falls through to detection when the legacy value is unusable", async () => {
    mocks.appSettingsGet.mockResolvedValue(settings({}));
    localStorage.setItem(LEGACY_KEY, "kl-GL");
    await i18n.changeLanguage("zh-CN");
    await wireAppSettingsStream();
    expect(persistedLanguage()).toBe("zh-CN");
  });
});
