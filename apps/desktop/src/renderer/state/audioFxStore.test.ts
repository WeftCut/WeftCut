import { beforeEach, describe, expect, it } from "vitest";

import type { LayerFxState } from "../../shared/audioEffects/status";
import {
  applyStatus,
  clear,
  deriveStatus,
  hydrate,
  layerFxState,
  readyAudioPath,
  readyPeaksKey,
  useAudioFxStore,
} from "./audioFxStore";

const SIG_A = "a".repeat(64);
const SIG_B = "b".repeat(64);

function ready(sig: string, peaks = "/cache/audio/waveforms/h.fx.peaks") {
  return {
    sig,
    media_hash: "deadbeef",
    audio_path: `/cache/audio/h.fx-${sig.slice(0, 16)}.conform`,
    peaks_path: peaks,
  };
}

function state(over: Partial<LayerFxState> = {}): LayerFxState {
  return { desired_sig: null, ready: null, pending: null, error: null, ...over };
}

describe("audioFxStore mirror", () => {
  beforeEach(() => clear());

  it("hydrate replaces the whole map", () => {
    applyStatus({ layer_id: "old", state: state({ desired_sig: SIG_A }) });
    hydrate({ L1: state({ desired_sig: SIG_B }) });
    expect(Object.keys(useAudioFxStore.getState().layers)).toEqual(["L1"]);
    expect(layerFxState("L1")?.desired_sig).toBe(SIG_B);
  });

  // An event carries the layer's FULL state, so the mirror overwrites rather
  // than merging: a dropped event must not leave a half-updated entry behind.
  it("applyStatus overwrites one layer and leaves the others alone", () => {
    hydrate({ L1: state({ desired_sig: SIG_A }), L2: state({ desired_sig: SIG_B }) });
    applyStatus({ layer_id: "L1", state: state({ desired_sig: SIG_A, ready: ready(SIG_A) }) });
    expect(layerFxState("L1")?.ready?.sig).toBe(SIG_A);
    expect(layerFxState("L2")?.desired_sig).toBe(SIG_B);
  });

  it("clear empties the map", () => {
    hydrate({ L1: state({ desired_sig: SIG_A }) });
    clear();
    expect(useAudioFxStore.getState().layers).toEqual({});
  });
});

describe("deriveStatus", () => {
  it("an unknown layer and an empty chain both read none", () => {
    expect(deriveStatus(undefined)).toBe("none");
    expect(deriveStatus(state())).toBe("none");
  });

  it("a satisfied desire reads ready", () => {
    expect(deriveStatus(state({ desired_sig: SIG_A, ready: ready(SIG_A) }))).toBe("ready");
  });

  it("an unsatisfied desire with no error reads pending", () => {
    expect(deriveStatus(state({ desired_sig: SIG_B, pending: SIG_B }))).toBe("pending");
  });

  it("an unsatisfied desire with an error reads failed", () => {
    const s = state({
      desired_sig: SIG_B,
      error: { message: "ffmpeg exited 1", effect_id: "E1", kind: "audio.denoise" },
    });
    expect(deriveStatus(s)).toBe("failed");
  });

  // Stale-while-revalidate: a new bake is running, so the status is pending
  // even though a previous artifact is still on disk and still playing.
  it("ready A with B pending reads pending", () => {
    const s = state({ desired_sig: SIG_B, ready: ready(SIG_A), pending: SIG_B });
    expect(deriveStatus(s)).toBe("pending");
    expect(readyAudioPath(s)).toBe(ready(SIG_A).audio_path);
  });

  // The baker keeps the last failure attached until a bake supersedes it, so a
  // SATISFIED desire outranks a stale error.
  it("a satisfied desire beats a stale error", () => {
    const s = state({
      desired_sig: SIG_A,
      ready: ready(SIG_A),
      error: { message: "an earlier bake failed", effect_id: null, kind: null },
    });
    expect(deriveStatus(s)).toBe("ready");
  });
});

describe("readyAudioPath", () => {
  it("is null for an unknown layer and for an empty chain", () => {
    expect(readyAudioPath(undefined)).toBeNull();
    expect(readyAudioPath(state({ ready: ready(SIG_A) }))).toBeNull();
  });

  // A failure never silently drops the layer back to the raw conform: the last
  // good artifact keeps playing until a new one lands (spec Decision 9).
  it("keeps the last ready artifact through a failure", () => {
    const s = state({
      desired_sig: SIG_B,
      ready: ready(SIG_A),
      error: { message: "boom", effect_id: null, kind: null },
    });
    expect(readyAudioPath(s)).toBe(ready(SIG_A).audio_path);
  });
});

describe("readyPeaksKey", () => {
  it("keys the baked waveform off the media hash and the sig's first 16", () => {
    const s = state({ desired_sig: SIG_A, ready: ready(SIG_A) });
    expect(readyPeaksKey(s)).toBe(`fx:deadbeef.fx-${"a".repeat(16)}`);
  });

  it("is null while no artifact exists, and while the chain is empty", () => {
    expect(readyPeaksKey(undefined)).toBeNull();
    expect(readyPeaksKey(state({ desired_sig: SIG_A, pending: SIG_A }))).toBeNull();
    expect(readyPeaksKey(state({ ready: ready(SIG_A) }))).toBeNull();
  });

  // A bake whose peaks sibling never landed still plays; the timeline just
  // stays on the raw waveform rather than asking for a file that is not there.
  it("is null when the artifact carries no peaks path", () => {
    const s = state({ desired_sig: SIG_A, ready: ready(SIG_A, "") });
    expect(readyPeaksKey(s)).toBeNull();
  });
});
