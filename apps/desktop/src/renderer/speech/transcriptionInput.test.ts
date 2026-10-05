import { describe, expect, it, vi } from "vitest";
import { checkTranscriptionInput, type TranscriptionSource } from "./transcriptionInput";

const source: TranscriptionSource = { layerId: "clip", label: "speech.wav", mediaId: "media", sourceStartUs: 2_000_000, sourceEndUs: 4_000_000 };
function reader(amplitudes = [0.04]) {
  return {
    levels: vi.fn().mockResolvedValue({ channels: amplitudes.length, levels: [{ level: 0, peaksPerSecond: 10, peakCount: 100 }] }),
    tile: vi.fn().mockImplementation(async (_id, _level, channel, _first, count) => ({
      peaksPerSecond: 10,
      min: Array(count).fill(-amplitudes[channel]!), max: Array(count).fill(amplitudes[channel]), rms: Array(count).fill(0),
    })),
  };
}

describe("transcription source level check", () => {
  it("warns on quiet source audio and reads only the selected source window", async () => {
    const waveform = reader();
    const issues = await checkTranscriptionInput([source], waveform);
    expect(issues).toEqual([{ layerId: "clip", label: "speech.wav", kind: "quiet", peakDbfs: expect.closeTo(-27.96, 2) }]);
    expect(waveform.tile).toHaveBeenCalledExactlyOnceWith("media", 0, 0, 20, 20);
  });

  it("does not flag audible speech merely because most of the clip is silent", async () => {
    const waveform = reader();
    waveform.tile.mockResolvedValue({ peaksPerSecond: 10, min: Array(20).fill(0), max: [0.4, ...Array(19).fill(0)], rms: Array(20).fill(0) });
    expect(await checkTranscriptionInput([source], waveform)).toEqual([]);
  });

  it("keeps the louder stereo channel, even for opposing polarity", async () => {
    expect(await checkTranscriptionInput([source], reader([0.01, 0.5]))).toEqual([]);
  });

  it("handles silence without non-finite diagnostic values", async () => {
    expect(await checkTranscriptionInput([source], reader([0]))).toMatchObject([{ kind: "quiet", peakDbfs: null }]);
  });

  it("reports missing or truncated waveforms as unchecked, not quiet", async () => {
    const missing = reader();
    missing.levels.mockRejectedValue(new Error("not_ready"));
    const truncated = reader();
    truncated.tile.mockResolvedValue({ min: [], max: [], rms: [], peaksPerSecond: 10 });
    for (const waveform of [missing, truncated]) {
      expect(await checkTranscriptionInput([source], waveform)).toMatchObject([{ kind: "unavailable" }]);
    }
  });

  it("bounds reads for a long source using peak-preserving coarser levels", async () => {
    const waveform = reader([0.4]);
    waveform.levels.mockResolvedValue({ channels: 1, levels: [
      { level: 0, peaksPerSecond: 100, peakCount: 360_000 },
      { level: 1, peaksPerSecond: 1, peakCount: 3600 },
    ] });
    expect(await checkTranscriptionInput([{ ...source, sourceStartUs: 0, sourceEndUs: 3_600_000_000 }], waveform)).toEqual([]);
    expect(waveform.tile).toHaveBeenCalledExactlyOnceWith("media", 1, 0, 0, 3600);
  });
});
