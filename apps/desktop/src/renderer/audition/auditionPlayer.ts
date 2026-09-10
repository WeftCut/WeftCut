// Playing a `planAudition` result: read the conform, stitch the kept segments,
// hand the browser one buffer.
//
// Boundary: owns the AudioContext, the range reads and the crossfade; owns no
// parameters and no policy — `planAudition.ts` decides what to play and
// `properties/PausesSection.tsx` decides when. Spec `.scratch/pauses/spec.md`
// Decision 7.
//
// Offline-stitched rather than a transport seek-and-skip, and that is the whole
// point: what a transport plays depends on preview performance, so the join
// heard would not necessarily be the join exported. The conform IS the samples
// (48 kHz f32le, no decode), so this excerpt is sample-exact.

import { convertFileSrc } from "@/bridge/ipc";
import type { LayerSummary } from "../ipc";
import { ConformSource } from "../render/audio/conformSource";
import { MICRO_FADE_S, SAMPLE_RATE } from "../render/audio/chunkSchedule";
import { layerFxState, readyAudioPath } from "../state/audioFxStore";
import { useProjectStore } from "../state/projectStore";
import type { AuditionSegment } from "./planAudition";

/// The audio the subject PLAYS, as a range-readable URL: the baked effect
/// sibling when one is ready for this layer, else the media's raw conform PCM,
/// null while the conform job has not landed.
///
/// The TWIN of the preview's own resolution (`render/PixiPreview.tsx`'s
/// `audioSourceUrl`, which is a closure inside the Compositor wiring and not
/// reachable from a panel). Both must answer the same file or the audition
/// plays the unprocessed take of a denoised clip — the one difference an ear
/// would blame on the detector.
///
/// Keyed by LAYER and not by media, for the preview's reason: two layers can
/// share one media and carry different chains (ADR 0063).
export function subjectConformUrl(subject: LayerSummary): string | null {
  const baked = readyAudioPath(layerFxState(subject.id));
  if (baked !== null) return convertFileSrc(baked);
  if (subject.params.kind !== "Audio") return null;
  const media = useProjectStore.getState().mediaById.get(subject.params.media_id);
  const path = media?.conform_path;
  return path ? convertFileSrc(path) : null;
}

/// A running audition. `stop()` is idempotent and safe at any point in the
/// load: the section calls it on unmount, on a subject change, on a parameter
/// change and on a second press, and none of those can wait for a range read.
export interface AuditionHandle {
  stop(): void;
}

const US_PER_SEC = 1_000_000;

/// One context for the whole session, built on first use. NOT the AudioGraph's
/// (spec Decision 7 asks for it): the graph lives inside the Compositor, which
/// reaches the panel only through a React ref threaded from the preview, and a
/// ref threaded across two Panels to save one context is a coupling that would
/// outlast this feature. An excerpt played through the same output device is
/// what the user is judging; the master bus's role gains are not part of the
/// question.
let sharedContext: AudioContext | null = null;

function audioContext(): AudioContext {
  sharedContext ??= new AudioContext({ sampleRate: SAMPLE_RATE });
  return sharedContext;
}

/// Round a source µs to the conform's 48 kHz frame grid — the axis every range
/// read takes.
function toFrame(us: number): number {
  return Math.round((us * SAMPLE_RATE) / US_PER_SEC);
}

/// The segments as ONE buffer, joined by a linear crossfade.
///
/// `MICRO_FADE_S` and not a longer fade: it is the same 5 ms the mixer's own
/// chunk seams use, so the excerpt's joins sound like the export's rather than
/// like a smoother edit than the one being auditioned. The overlap is clamped
/// to the shorter neighbour, so a segment thinner than the fade still joins
/// instead of reading past its own end.
async function stitch(
  source: ConformSource,
  segments: readonly AuditionSegment[],
): Promise<AudioBuffer | null> {
  const fadeFrames = Math.round(MICRO_FADE_S * SAMPLE_RATE);
  const reads: { start: number; count: number }[] = [];
  for (const seg of segments) {
    const start = toFrame(seg.srcStartUs);
    const count = toFrame(seg.srcEndUs) - start;
    if (count > 0) reads.push({ start, count });
  }
  if (reads.length === 0) return null;

  const channels = source.header.channels;
  let total = reads[0]!.count;
  const overlaps: number[] = [0];
  for (let i = 1; i < reads.length; i++) {
    const overlap = Math.min(fadeFrames, reads[i - 1]!.count, reads[i]!.count);
    overlaps.push(overlap);
    total += reads[i]!.count - overlap;
  }

  const out = Array.from({ length: channels }, () => new Float32Array(total));
  let offset = 0;
  for (let i = 0; i < reads.length; i++) {
    const read = reads[i]!;
    const planes = await source.readWindow(read.start, read.count);
    const overlap = overlaps[i]!;
    const at = offset - overlap;
    for (let c = 0; c < channels; c++) {
      const src = planes[c] ?? planes[0]!;
      const dst = out[c]!;
      for (let f = 0; f < overlap; f++) {
        const gain = (f + 1) / (overlap + 1);
        dst[at + f] = dst[at + f]! * (1 - gain) + src[f]! * gain;
      }
      for (let f = overlap; f < read.count; f++) dst[at + f] = src[f]!;
    }
    offset = at + read.count;
  }

  const ctx = audioContext();
  const buffer = ctx.createBuffer(channels, total, SAMPLE_RATE);
  for (let c = 0; c < channels; c++) buffer.copyToChannel(out[c]!, c);
  return buffer;
}

/// Start playing, and hand back the stop.
///
/// Synchronous by design even though the load is not: the caller must be able
/// to stop an audition it has not finished opening — an unmount during a range
/// read is the ordinary case — and a promise it would have to await first
/// cannot do that.
///
/// `onEnded` fires on a natural end only. A caller that pressed *Stop* already
/// knows.
export function startAudition(args: {
  url: string;
  segments: readonly AuditionSegment[];
  onEnded: () => void;
  onFailed?: (error: unknown) => void;
}): AuditionHandle {
  let stopped = false;
  let node: AudioBufferSourceNode | null = null;
  void (async () => {
    try {
      const source = await ConformSource.open(args.url);
      if (stopped) return;
      const buffer = await stitch(source, args.segments);
      if (stopped || buffer === null) {
        if (!stopped) args.onEnded();
        return;
      }
      const ctx = audioContext();
      // Autoplay policy: a context created before the first gesture starts
      // suspended, and this IS a gesture's consequence, so resuming is enough.
      if (ctx.state !== "running") void ctx.resume();
      const playing = ctx.createBufferSource();
      playing.buffer = buffer;
      playing.connect(ctx.destination);
      playing.onended = () => {
        if (!stopped) args.onEnded();
      };
      node = playing;
      playing.start();
    } catch (err) {
      if (stopped) return;
      args.onFailed?.(err);
      args.onEnded();
    }
  })();
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (node !== null) {
        node.onended = null;
        try {
          node.stop();
        } catch {
          // Already ended: `stop()` on a finished source throws in some engines
          // and means nothing here — the handle's contract is idempotence.
        }
        node.disconnect();
        node = null;
      }
    },
  };
}
