import { describe, it, expect } from "vitest";
import { AUDIO_FX_STATUS_EVENT, fxWaveformKey, parseFxWaveformKey } from "./status";

const HASH = "9f2c4a1b";
const SIG16 = "0123456789abcdef";

describe("fxWaveformKey / parseFxWaveformKey", () => {
  it("round-trips a baked waveform key", () => {
    const key = fxWaveformKey(HASH, SIG16);
    expect(key).toBe(`fx:${HASH}.fx-${SIG16}`);
    expect(parseFxWaveformKey(key)).toEqual({ mediaHash: HASH, sig16: SIG16 });
  });

  // A media id is the OTHER kind of waveform key (the raw conform), so the
  // parse has to answer null rather than throw — the caller branches on shape.
  it("answers null for a media id and for a malformed key", () => {
    expect(parseFxWaveformKey("11111111-2222-3333-4444-555555555555")).toBeNull();
    expect(parseFxWaveformKey("")).toBeNull();
    expect(parseFxWaveformKey(`fx:${HASH}`)).toBeNull();
    expect(parseFxWaveformKey(`fx:${HASH}.fx-tooshort`)).toBeNull();
    expect(parseFxWaveformKey(`fx:${HASH}.fx-${SIG16}extra`)).toBeNull();
    expect(parseFxWaveformKey(`${HASH}.fx-${SIG16}`)).toBeNull();
  });

  it("pins the status event name — main emits it, the renderer subscribes", () => {
    expect(AUDIO_FX_STATUS_EVENT).toBe("audio_fx:status");
  });
});
