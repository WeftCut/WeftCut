import { describe, expect, it } from "vitest";
import { DEFAULT_EXPORT_SETTINGS } from "./exportSettings";
import { EXPORT_SETTINGS_SCHEMA, ExportValidationError, resolveExportOptions, resolveExportRequest } from "./exportValidation";

const comp = { width: 1920, height: 1080, fps_num: 30_000, fps_den: 1001, duration_us: 10_010_000 };
const resolve = (overrides: unknown = {}, saved: unknown = null) => resolveExportRequest(saved, overrides, comp);

describe("resolveExportRequest", () => {
  it("allows inspecting options for an empty composition while refusing export", () => {
    const empty = { ...comp, duration_us: 0 };
    const result = resolveExportOptions(null, empty);
    expect(result.settings).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(result.fps).toEqual({ num: 30_000, den: 1001 });
    expect(result).not.toHaveProperty("range");
    expect(() => resolveExportRequest(null, {}, empty)).toThrow(ExportValidationError);
  });

  it("still rejects malformed empty-composition options", () => {
    expect(() => resolveExportOptions(null, { ...comp, duration_us: -1 })).toThrow(ExportValidationError);
    expect(() => resolveExportOptions(null, { ...comp, duration_us: 0, width: 0 })).toThrow(ExportValidationError);
  });

  it.each([
    { quality: "custom", customBitrate: null },
    { maxBitrate: 1 },
    { resolutionHeight: 2160 },
    { fps: 60 },
    { includeVideo: false, includeAudio: false },
  ])("exposes persisted draft settings and a validation issue %j", (saved) => {
    const result = resolveExportOptions(saved, comp);
    expect(result.settings).toMatchObject(saved);
    expect(result.validation_issue).toEqual(expect.any(String));
    expect(() => resolveExportRequest(saved, undefined, comp)).toThrow(ExportValidationError);
  });

  it("omits a validation issue for valid defaults", () => {
    expect(resolveExportOptions(null, comp)).not.toHaveProperty("validation_issue");
  });
  it("backfills defaults and preserves the rational composition rate", () => {
    expect(resolve()).toEqual({
      settings: DEFAULT_EXPORT_SETTINGS, range: { startUs: 0, endUs: comp.duration_us },
      dimensions: { width: 1920, height: 1080 }, fps: { num: 30_000, den: 1001 }, extension: "mp4",
    });
  });

  it("merges nested audio overrides without replacing saved fields", () => {
    const result = resolve({ audio: { channels: 1 } }, { audio: { bitrate: 320_000 }, preset: "slow" });
    expect(result.settings.audio).toEqual({ ...DEFAULT_EXPORT_SETTINGS.audio, channels: 1, bitrate: 320_000 });
    expect(result.settings.preset).toBe("slow");
  });

  it("backfills legacy audio inclusion and repairs legacy incompatible fields", () => {
    const result = resolve({}, { audio: { include: false }, codec: "h264", bitDepth: 10, maxBitrate: -1 });
    expect(result.settings.includeAudio).toBe(false);
    expect(result.settings.audio.include).toBe(false);
    expect(result.settings.bitDepth).toBe(8);
    expect(result.settings.maxBitrate).toBeNull();
  });

  it.each([{ includeAudio: false }, { audio: { include: false } }])("mirrors explicit audio inclusion %j", (patch) => {
    const result = resolve(patch);
    expect(result.settings.includeAudio).toBe(false);
    expect(result.settings.audio.include).toBe(false);
  });

  it("rejects conflicting explicit inclusion flags", () => {
    expect(() => resolve({ includeAudio: true, audio: { include: false } })).toThrow(ExportValidationError);
  });

  it.each([
    null, [], "settings", { mystery: true }, { audio: null }, { audio: { unknown: true } },
    { bitDepth: 12 }, { codec: "vp9" }, { fps: NaN }, { fps: 25.5 }, { customBitrate: Infinity },
    { customBitrate: -1 }, { maxBitrate: 0 }, { bufferSize: 0 }, { crf: 52 }, { crf: 1.5 },
    { audio: { sampleRate: 96000 } }, { audio: { channels: 6 } }, { includeVideo: "false" },
    { keyframeIntervalSec: 0 }, { decodeEngine: "invalid" },
  ])("rejects malformed explicit overrides %j", (patch) => {
    expect(() => resolve(patch)).toThrow(ExportValidationError);
  });

  it.each([
    { codec: "h264", bitDepth: 10 }, { codec: "av1", container: "mov" },
    { codec: "prores", bitDepth: 10 }, { codec: "dnxhr", container: "mov", bitDepth: 10 },
    { audio: { codec: "opus" } }, { includeVideo: false, includeAudio: false },
    { encoderEngine: "webcodecs", rateMode: "quality" },
    { encoderEngine: "webcodecs", codec: "hevc", bitDepth: 10 },
    { encoderEngine: "webcodecs", codec: "prores", bitDepth: 10, container: "mov" },
    { quality: "custom" }, { resolutionHeight: 2160 }, { resolutionHeight: 1 }, { fps: 30 },
    { maxBitrate: 1 },
  ])("rejects incompatible settings without correcting explicit choices %j", (patch) => {
    expect(() => resolve(patch)).toThrow(ExportValidationError);
  });

  it.each([
    [{ codec: "prores", container: "mov", bitDepth: 10 }, "mov"],
    [{ codec: "dnxhr", container: "mov", bitDepth: 8 }, "mov"],
    [{ codec: "av1", container: "mkv", audio: { codec: "opus" } }, "mkv"],
    [{ includeVideo: false }, "m4a"],
    [{ includeVideo: false, audio: { codec: "opus" } }, "mka"],
    [{ includeAudio: false }, "mp4"],
  ])("accepts compatible output settings %j", (patch, extension) => {
    expect(resolve(patch).extension).toBe(extension);
  });

  it("requires opt-in for delivery 10-bit but exempts ProRes", () => {
    const patch = { codec: "hevc", bitDepth: 10 };
    expect(() => resolve(patch)).toThrow("allowExperimental10bit");
    expect(resolveExportRequest(null, patch, comp, undefined, true).settings.bitDepth).toBe(10);
    expect(resolve({ codec: "prores", container: "mov", bitDepth: 10 }).settings.bitDepth).toBe(10);
  });

  it("does not require video-specific compatibility for audio-only output", () => {
    expect(resolve({ includeVideo: false, codec: "hevc", bitDepth: 10 }).extension).toBe("m4a");
  });

  it("resolves downscaled even dimensions and explicit fps", () => {
    const result = resolve({ resolutionHeight: 720, fps: 24 });
    expect(result.dimensions).toEqual({ width: 1280, height: 720 });
    expect(result.fps).toEqual({ num: 24, den: 1 });
  });

  it("allows custom quality only with a usable target", () => {
    expect(resolve({ quality: "custom", customBitrate: 10_000_000 }).settings.customBitrate).toBe(10_000_000);
    expect(resolve({ quality: "custom", rateMode: "quality" }).settings.rateMode).toBe("quality");
  });

  it("snaps range endpoints on the rational root frame grid", () => {
    const result = resolveExportRequest(null, {}, comp, { startUs: 34_000, endUs: 101_000 });
    expect(result.range).toEqual({ startUs: 33_367, endUs: 100_100 });
  });

  it("uses the supplied canonical frame snap for both endpoints", () => {
    const calls: number[] = [];
    const result = resolveExportRequest(null, {}, comp, { startUs: 1, endUs: 100 }, false, (time, num, den) => {
      expect([num, den]).toEqual([30_000, 1001]);
      calls.push(time);
      return time === 1 ? 0 : 33_367;
    });
    expect(calls).toEqual([1, 100]);
    expect(result.range).toEqual({ startUs: 0, endUs: 33_367 });
  });

  it.each([
    { startUs: -1, endUs: 100 }, { startUs: 0, endUs: comp.duration_us + 1 },
    { startUs: 100, endUs: 50 }, { startUs: 100, endUs: 100 }, { startUs: 1, endUs: 2 },
    { startUs: NaN, endUs: 100 }, { startUs: 0.5, endUs: 100 },
  ])("rejects invalid or snap-empty ranges without widening %j", (range) => {
    expect(() => resolveExportRequest(null, {}, comp, range)).toThrow(ExportValidationError);
  });

  it("rejects a range that snaps beyond the composition", () => {
    expect(() => resolveExportRequest(null, {}, { ...comp, duration_us: 51_000 },
      { startUs: 0, endUs: 51_000 })).toThrow(ExportValidationError);
  });

  it.each(["width", "height", "fps_num", "fps_den", "duration_us"])("rejects invalid composition %s", (key) => {
    expect(() => resolveExportRequest(null, {}, { ...comp, [key]: 0 })).toThrow(ExportValidationError);
  });

  it("exposes a strict schema containing all default settings", () => {
    expect(Object.keys(EXPORT_SETTINGS_SCHEMA.properties).sort()).toEqual(Object.keys(DEFAULT_EXPORT_SETTINGS).sort());
    expect(EXPORT_SETTINGS_SCHEMA.additionalProperties).toBe(false);
    expect(EXPORT_SETTINGS_SCHEMA.properties.audio.additionalProperties).toBe(false);
  });

  it("returns machine-readable invalid_params failures", () => {
    try { resolve({ codec: "invalid" }); } catch (error) {
      expect(error).toBeInstanceOf(ExportValidationError);
      expect((error as ExportValidationError).code).toBe("invalid_params");
      return;
    }
    throw new Error("Expected validation failure");
  });
});
