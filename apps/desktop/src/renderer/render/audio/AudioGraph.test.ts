// Master and per-Role bus parts over a mocked AudioContext — dB conversion,
// silent meter snapshots, mute toggling, and the wiring invariants the Role
// buses have to hold. Topology against a real context is covered by the e2e
// phase.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIO_ROLES } from "../../ipc";
import { AudioGraph, linearToDb } from "./AudioGraph";

/// The shape the fake nodes expose: recorded `connect` targets, so wiring is
/// assertable through the public surface instead of the graph's private fields.
interface RecordedNode {
  outputs: unknown[];
  fftSize: number;
}

function outputsOf(node: unknown): unknown[] | undefined {
  return (node as Partial<RecordedNode>).outputs;
}

/// Is there a signal path from `from` to `target`, following recorded connects?
function reaches(from: unknown, target: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [from];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of outputsOf(node) ?? []) stack.push(next);
  }
  return false;
}

function mockAudioContext(): void {
  class FakeNode {
    gain = { value: 1 };
    threshold = { value: 0 };
    ratio = { value: 0 };
    attack = { value: 0 };
    release = { value: 0 };
    knee = { value: 0 };
    fftSize = 0;
    smoothingTimeConstant = 0;
    readonly outputs: unknown[] = [];
    connect = vi.fn((target: unknown) => {
      this.outputs.push(target);
      return target;
    });
    disconnect = vi.fn(() => {
      this.outputs.length = 0;
    });
    getFloatTimeDomainData = (arr: Float32Array): void => {
      arr.fill(0);
    };
  }
  class FakeAudioContext {
    state = "running";
    destination = {};
    createGain = (): FakeNode => new FakeNode();
    createAnalyser = (): FakeNode => new FakeNode();
    createDynamicsCompressor = (): FakeNode => new FakeNode();
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {});
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("linearToDb", () => {
  it("maps silence to -Infinity and unity to 0 dB", () => {
    expect(linearToDb(0)).toBe(-Infinity);
    expect(linearToDb(1)).toBeCloseTo(0, 9);
    expect(linearToDb(0.5)).toBeCloseTo(-6.0206, 3);
  });
});

describe("AudioGraph", () => {
  it("reports -Infinity meter levels over silence", () => {
    mockAudioContext();
    const g = new AudioGraph();
    const snap = g.meterSnapshot();
    expect(snap.rmsDb).toBe(-Infinity);
    expect(snap.peakDb).toBe(-Infinity);
  });

  it("master mute toggles the input gain", () => {
    mockAudioContext();
    const g = new AudioGraph();
    g.setMasterMute(true);
    expect(g.input.gain.value).toBe(0);
    g.setMasterMute(false);
    expect(g.input.gain.value).toBe(1);
  });

  it("gives every Role its own bus, and each bus reaches the master input", () => {
    mockAudioContext();
    const g = new AudioGraph();
    const buses = AUDIO_ROLES.map((role) => g.roleBusInput(role));
    expect(new Set(buses).size).toBe(AUDIO_ROLES.length);
    for (const bus of buses) {
      // Where a layer chain ends. From there the signal has to reach the
      // master input, and through it the destination.
      expect(reaches(bus, g.input)).toBe(true);
      expect(reaches(bus, g.ctx.destination)).toBe(true);
    }
  });

  it("meters a Role off a leaf tap, so the tap cannot alter an output sample", () => {
    mockAudioContext();
    const g = new AudioGraph();
    const outs = outputsOf(g.roleBusInput("music"));
    expect(outs).toHaveLength(2);
    const audible = outs!.filter((node) => reaches(node, g.ctx.destination));
    expect(audible).toHaveLength(1);
    const tap = outs!.find((node) => node !== audible[0]);
    expect((tap as RecordedNode).fftSize).toBe(2048);
    // Terminates: there is nothing downstream to carry a change into.
    expect(outputsOf(tap)).toEqual([]);
  });

  it("holds every Role bus at unity, master mute included", () => {
    // The Role gain is folded into each member layer's own envelope upstream
    // of the bus, so a bus gain that is anything but 1 applies it twice.
    mockAudioContext();
    const g = new AudioGraph();
    for (const role of AUDIO_ROLES) {
      expect(g.roleBusInput(role).gain.value).toBe(1);
    }
    g.setMasterMute(true);
    for (const role of AUDIO_ROLES) {
      expect(g.roleBusInput(role).gain.value).toBe(1);
    }
  });

  it("reports -Infinity Role levels over silence", () => {
    mockAudioContext();
    const g = new AudioGraph();
    const silent = { rmsDb: -Infinity, peakDb: -Infinity };
    for (const role of AUDIO_ROLES) {
      expect(g.roleMeterSnapshot(role)).toEqual(silent);
    }
    expect(g.roleMeterSnapshots()).toEqual({
      dialogue: silent,
      music: silent,
      sfx: silent,
      voiceover: silent,
    });
  });
});
