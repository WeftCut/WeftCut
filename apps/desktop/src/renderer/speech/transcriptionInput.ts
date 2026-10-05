import { getWaveformLevels, getWaveformTile, type WaveformLevels, type WaveformTile } from "../ipc";

export interface TranscriptionSource {
  layerId: string;
  label: string;
  mediaId: string;
  sourceStartUs: number;
  sourceEndUs: number;
}

export type TranscriptionInputIssue = Pick<TranscriptionSource, "layerId" | "label"> & (
  | { kind: "quiet"; peakDbfs: number | null }
  | { kind: "unavailable" }
);

export type TranscriptionInputDecision = false | { normalizeLayerIds: readonly string[] };

/** Preview only; native remeasures the actual mono transcription WAV. */
export function estimatedNormalizationGain(peakDbfs: number): number {
  return Math.min(24, Math.max(0, -3 - peakDbfs));
}

// Conservative advisory: even the loudest channel/bin is below -24 dBFS.
// Peak, rather than whole-clip RMS, avoids flagging ordinary speech merely
// because it is surrounded by silence. This is not a speech-quality verdict.
const QUIET_PEAK = 10 ** (-24 / 20);
const MAX_BINS = 4096;
interface WaveformReader {
  levels: (mediaId: string) => Promise<WaveformLevels>;
  tile: (mediaId: string, level: number, channel: number, start: number, count: number) => Promise<WaveformTile>;
}
const reader: WaveformReader = { levels: getWaveformLevels, tile: getWaveformTile };

/** Reads raw source waveforms only. Never changes gain, effects, media or the
 * transcription WAV. Coarse bins retain maxima; boundary bins can therefore
 * suppress a warning, but cannot invent low volume by discarding a transient. */
export async function checkTranscriptionInput(
  sources: readonly TranscriptionSource[],
  waveform: WaveformReader = reader,
): Promise<TranscriptionInputIssue[]> {
  const issues: TranscriptionInputIssue[] = [];
  for (const source of sources) {
    const identity = { layerId: source.layerId, label: source.label };
    try {
      if (!Number.isFinite(source.sourceStartUs) || !Number.isFinite(source.sourceEndUs)
        || source.sourceStartUs < 0 || source.sourceEndUs <= source.sourceStartUs) throw new Error("Invalid source window");
      const header = await waveform.levels(source.mediaId);
      const levels = header.levels.filter(l => l.peaksPerSecond > 0 && Number.isFinite(l.peaksPerSecond) && l.peakCount > 0)
        .sort((a, b) => b.peaksPerSecond - a.peaksPerSecond);
      const bounds = (density: number) => ({
        first: Math.floor(source.sourceStartUs / 1e6 * density),
        last: Math.ceil(source.sourceEndUs / 1e6 * density),
      });
      const level = levels.find(l => {
        const { first, last } = bounds(l.peaksPerSecond);
        return last - first <= MAX_BINS;
      });
      if (!level || !Number.isInteger(header.channels) || header.channels < 1 || header.channels > 2)
        throw new Error("Waveform unavailable");
      const { first, last } = bounds(level.peaksPerSecond);
      // An incomplete cache is unknown, never evidence that a clip is quiet.
      if (last > level.peakCount || last <= first) throw new Error("Incomplete waveform");
      let peak = 0;
      for (let channel = 0; channel < header.channels; channel++) {
        const tile = await waveform.tile(source.mediaId, level.level, channel, first, last - first);
        if (tile.min.length !== last - first || tile.max.length !== last - first)
          throw new Error("Incomplete waveform tile");
        for (let i = 0; i < tile.min.length; i++) {
          const magnitude = Math.max(Math.abs(tile.min[i]!), Math.abs(tile.max[i]!));
          if (!Number.isFinite(magnitude)) throw new Error("Invalid waveform sample");
          peak = Math.max(peak, magnitude);
        }
      }
      if (peak < QUIET_PEAK) issues.push({ ...identity, kind: "quiet", peakDbfs: peak === 0 ? null : 20 * Math.log10(peak) });
    } catch {
      issues.push({ ...identity, kind: "unavailable" });
    }
  }
  return issues;
}
