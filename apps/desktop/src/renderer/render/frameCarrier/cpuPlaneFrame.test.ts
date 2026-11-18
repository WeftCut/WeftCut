import { describe, expect, it } from "vitest";
import type { DecodeWireFrame } from "../../../shared/frameCarrier/wire";
import { resolveSourceColor } from "../decoder/ffprobeColorSpace";
import { isNativeNv12Frame } from "../decoder/nv12Frame";
import { isTenBitFrame } from "../decoder/tenBitFrame";
import { cpuPlaneFrame } from "./cpuPlaneFrame";

const HD = resolveSourceColor({ width: 1920, height: 1080 });

const msg = (over: Partial<DecodeWireFrame>): DecodeWireFrame => ({
  kind: "bytes",
  lease: 1,
  ptsUs: 40,
  durUs: 33,
  width: 2,
  height: 2,
  format: "NV12",
  data: new Uint8Array(6),
  ...over,
});

describe("cpuPlaneFrame", () => {
  it("wraps on the layout the frame names, adopting its bytes and stamping the given colour", () => {
    const nv12 = msg({});
    const a = cpuPlaneFrame(nv12, HD);
    expect(isNativeNv12Frame(a)).toBe(true);
    expect(a.data).toBe(nv12.data);
    expect(a.colorSpace).toBe(HD);
    expect([a.timestamp, a.duration]).toEqual([40, 33]);

    const p10 = msg({ format: "I420P10", data: new Uint8Array(12) });
    const b = cpuPlaneFrame(p10, HD);
    expect(isTenBitFrame(b)).toBe(true);
    expect(b.data).toBe(p10.data);
  });

  it("throws when the bytes do not match the named layout", () => {
    expect(() => cpuPlaneFrame(msg({ data: new Uint8Array(5) }), HD)).toThrow("layout drift");
    expect(() => cpuPlaneFrame(msg({ format: "I420P10", data: new Uint8Array(6) }), HD)).toThrow("layout drift");
  });
});
