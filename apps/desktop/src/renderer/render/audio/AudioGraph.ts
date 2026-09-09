// Master audio bus for the preview mixer (docs/audio.md §Preview mixer):
//
//   layer chains → roleBus gain (unity) → input (GainNode, master mute)
//                                      ↘  roleBus analyser (terminates)
//
//   input → analyser (master meter tap) → DynamicsCompressor → destination
//
// Every layer chain fans in through its Role's bus rather than straight into
// `input`, so each Role can be metered where its members already sum. A Role
// bus is a metering TAP, not a DSP insert: unity gain, and an analyser wired as
// a LEAF, so no bus can alter an output sample. Per-Role effects inserts are
// the extension point ADR 0023 defers.
//
// The meter taps are surfaced to the dev PerfHUD, over MCP, and to the master
// and per-Role levels in `panels/MixerPanel.tsx` (via `state/masterMeterStore`).

import { AUDIO_ROLES, type AudioRole } from "../../ipc";

export interface MeterSnapshot {
  /// dBFS; -Infinity when silent.
  rmsDb: number;
  peakDb: number;
}

export function linearToDb(v: number): number {
  if (v <= 0) return -Infinity;
  return 20 * Math.log10(v);
}

/// One metering point: an analyser plus the buffer its reads land in. Master
/// and every Role bus own one, so they read on identical settings.
interface MeterTap {
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
}

/// A Role's fan-in point: the node every member layer's chain connects to, and
/// the leaf analyser metering it.
interface RoleBus {
  gain: GainNode;
  tap: MeterTap;
}

function createMeterTap(ctx: BaseAudioContext): MeterTap {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;
  // Explicit ArrayBuffer so the strict Float32Array<ArrayBuffer>
  // analyser overload accepts it.
  return {
    analyser,
    buf: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)),
  };
}

/// One combined-channel RMS + peak read off a tap. Per-channel splitting is
/// future work.
function readMeterTap(tap: MeterTap): MeterSnapshot {
  tap.analyser.getFloatTimeDomainData(tap.buf);
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < tap.buf.length; i++) {
    const s = tap.buf[i]!;
    sumSq += s * s;
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sumSq / tap.buf.length);
  return { rmsDb: linearToDb(rms), peakDb: linearToDb(peak) };
}

export class AudioGraph {
  readonly ctx: AudioContext;
  private readonly inputNode: GainNode;
  private readonly masterTap: MeterTap;
  private readonly compressor: DynamicsCompressorNode;
  private readonly roleBuses: Record<AudioRole, RoleBus>;

  constructor() {
    // 48 kHz to match the conform canonical rate; if the device forces a
    // different rate the context resamples AudioBuffers transparently.
    this.ctx = new AudioContext({ sampleRate: 48_000 });

    this.inputNode = this.ctx.createGain();
    this.inputNode.gain.value = 1;

    this.masterTap = createMeterTap(this.ctx);

    // Soft overload protection only — the export-side alimiter is the
    // contract; this is the preview approximation of it.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -1;
    this.compressor.ratio.value = 20;
    this.compressor.attack.value = 0.001;
    this.compressor.release.value = 0.25;
    this.compressor.knee.value = 0;

    this.inputNode.connect(this.masterTap.analyser);
    this.masterTap.analyser.connect(this.compressor);
    this.compressor.connect(this.ctx.destination);

    const buses = {} as Record<AudioRole, RoleBus>;
    for (const role of AUDIO_ROLES) {
      const gain = this.ctx.createGain();
      // UNITY, PERMANENTLY. The Role gain is already folded into each member
      // layer's own gain envelope upstream of this fan-in (`AudioMixer`
      // .deriveFromView); setting it here as well applies it twice.
      gain.gain.value = 1;
      gain.connect(this.inputNode);
      const tap = createMeterTap(this.ctx);
      // Leaf: the analyser terminates here and feeds nothing onward, which is
      // what makes the tap unable to change what the user hears.
      gain.connect(tap.analyser);
      buses[role] = { gain, tap };
    }
    this.roleBuses = buses;
  }

  /// The master node every Role bus sums into. Layer chains connect to their
  /// Role's bus (`roleBusInput`), not here.
  get input(): GainNode {
    return this.inputNode;
  }

  /// The node a layer chain of `role` fans into — unity gain; see the
  /// constructor.
  roleBusInput(role: AudioRole): GainNode {
    return this.roleBuses[role].gain;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== "running") {
      await this.ctx.resume();
    }
  }

  setMasterMute(muted: boolean): void {
    this.inputNode.gain.value = muted ? 0 : 1;
  }

  /// Master output level.
  meterSnapshot(): MeterSnapshot {
    return readMeterTap(this.masterTap);
  }

  /// One Role's contribution to the mix, gain already folded in by its member
  /// layers. A gated Role reads true silence: the audio pass skips gated
  /// layers rather than zeroing them, so nothing reaches the bus.
  roleMeterSnapshot(role: AudioRole): MeterSnapshot {
    return readMeterTap(this.roleBuses[role].tap);
  }

  /// All four Roles read from the same instant — what a publication that
  /// replaces the whole per-Role slice wants.
  roleMeterSnapshots(): Record<AudioRole, MeterSnapshot> {
    const out = {} as Record<AudioRole, MeterSnapshot>;
    for (const role of AUDIO_ROLES) out[role] = this.roleMeterSnapshot(role);
    return out;
  }

  dispose(): void {
    try {
      this.inputNode.disconnect();
      this.masterTap.analyser.disconnect();
      this.compressor.disconnect();
      for (const role of AUDIO_ROLES) {
        const bus = this.roleBuses[role];
        bus.gain.disconnect();
        bus.tap.analyser.disconnect();
      }
    } catch {
      // best-effort
    }
    void this.ctx.close();
  }
}
