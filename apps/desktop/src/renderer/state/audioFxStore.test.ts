import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AudioFxSnapshot,
  AudioFxStatusEvent,
  LayerFxState,
} from "../../shared/audioEffects/status";
import {
  applyStatus,
  bootAudioFxStore,
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

/// Drains the microtask turns a chained seed read needs to settle.
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
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

describe("bootAudioFxStore", () => {
  /// A `listen` that hands the test the handler it registered, so a push can be
  /// delivered at an exact point relative to the seed read.
  function fakeListen() {
    const handlers: Array<(e: { payload: AudioFxStatusEvent }) => void> = [];
    const unlisten = vi.fn();
    const events: string[] = [];
    return {
      handlers,
      unlisten,
      events,
      listen: async (
        event: string,
        handler: (e: { payload: AudioFxStatusEvent }) => void,
      ) => {
        events.push(event);
        handlers.push(handler);
        return unlisten;
      },
    };
  }

  it("seeds from the snapshot, then applies pushes", async () => {
    const l = fakeListen();
    const unsub = await bootAudioFxStore({
      listen: l.listen,
      snapshot: async () => ({ L1: state({ desired_sig: SIG_A }) }),
    });
    expect(l.events).toEqual(["audio_fx:status"]);
    expect(layerFxState("L1")?.desired_sig).toBe(SIG_A);

    l.handlers[0]!({
      payload: { layer_id: "L2", state: state({ desired_sig: SIG_B }) },
    });
    expect(layerFxState("L2")?.desired_sig).toBe(SIG_B);

    unsub();
    expect(l.unlisten).toHaveBeenCalledTimes(1);
  });

  // The listener goes up BEFORE the seed read, so a push can land while the
  // snapshot is in flight. The snapshot is the older value of the two, so the
  // push has to win — and it cannot simply be dropped, because nothing re-sends
  // it.
  it("keeps a push that arrives while the snapshot is in flight", async () => {
    const l = fakeListen();
    let releaseSnapshot: (() => void) | null = null;
    const snapshotGate = new Promise<void>((r) => {
      releaseSnapshot = r;
    });
    const booting = bootAudioFxStore({
      listen: l.listen,
      snapshot: async () => {
        await snapshotGate;
        return { L1: state({ desired_sig: SIG_A }) };
      },
    });
    await Promise.resolve();
    l.handlers[0]!({
      payload: { layer_id: "L1", state: state({ desired_sig: SIG_B }) },
    });
    releaseSnapshot!();
    const unsub = await booting;

    expect(layerFxState("L1")?.desired_sig).toBe(SIG_B);
    unsub();
  });

  it("keeps listening when the snapshot read fails", async () => {
    const l = fakeListen();
    const unsub = await bootAudioFxStore({
      listen: l.listen,
      snapshot: async () => {
        throw new Error("the audio-fx baker is not started yet");
      },
    });
    l.handlers[0]!({
      payload: { layer_id: "L1", state: state({ desired_sig: SIG_A }) },
    });
    expect(layerFxState("L1")?.desired_sig).toBe(SIG_A);
    unsub();
  });

  // The baker rebuilds its map from scratch on a project switch, so a layer of
  // the closed project left here would still name its artifact.
  it("re-seeds on a project switch and unsubscribes both wires", async () => {
    const l = fakeListen();
    let snapshot: AudioFxSnapshot = { OLD: state({ desired_sig: SIG_A }) };
    let onSwitch: (() => void) | null = null;
    const unsubProject = vi.fn();
    const unsub = await bootAudioFxStore({
      listen: l.listen,
      snapshot: async () => snapshot,
      onProjectSwitch: (cb) => {
        onSwitch = cb;
        return unsubProject;
      },
    });
    expect(Object.keys(useAudioFxStore.getState().layers)).toEqual(["OLD"]);

    snapshot = { NEW: state({ desired_sig: SIG_B }) };
    onSwitch!();
    await flush();
    expect(Object.keys(useAudioFxStore.getState().layers)).toEqual(["NEW"]);

    unsub();
    expect(l.unlisten).toHaveBeenCalledTimes(1);
    expect(unsubProject).toHaveBeenCalledTimes(1);
  });

  // Closing a project takes the baker's answer away with it; the entries left
  // behind would name artifacts of a project nothing is playing any more.
  it("empties the mirror when the re-seed finds no project", async () => {
    const l = fakeListen();
    let fail = false;
    let onSwitch: (() => void) | null = null;
    const unsub = await bootAudioFxStore({
      listen: l.listen,
      snapshot: async () => {
        if (fail) throw new Error("no project");
        return { L1: state({ desired_sig: SIG_A }) };
      },
      onProjectSwitch: (cb) => {
        onSwitch = cb;
        return () => {};
      },
    });
    expect(layerFxState("L1")).toBeDefined();

    fail = true;
    onSwitch!();
    await flush();
    expect(useAudioFxStore.getState().layers).toEqual({});
    unsub();
  });
});
