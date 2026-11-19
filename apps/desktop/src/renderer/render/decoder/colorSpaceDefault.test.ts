import { describe, expect, it } from "vitest";
import { decodesInSoftwareForColour, withDefaultColorSpace } from "./colorSpaceDefault";
import { resolveSourceColor } from "./ffprobeColorSpace";

const base = (over: Partial<VideoDecoderConfig> = {}): VideoDecoderConfig =>
  ({ codec: "avc1.640028", codedWidth: 1920, codedHeight: 1080, ...over }) as VideoDecoderConfig;

const SD = resolveSourceColor({ height: 480 });
const HD = resolveSourceColor({ height: 1080 });
const BT601 = { primaries: "smpte170m", transfer: "smpte170m", matrix: "smpte170m", fullRange: false };
const BT709 = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };

describe("withDefaultColorSpace", () => {
  it("takes every field from sourceColor when the decode target carries no colr tag", () => {
    expect(withDefaultColorSpace(base(), SD).colorSpace).toEqual(BT601);
    expect(withDefaultColorSpace(base(), HD).colorSpace).toEqual(BT709);
  });

  it("ignores the decode target's height", () => {
    // A 1080-line decode of an SD original, and a 360-line proxy of an HD one.
    expect(withDefaultColorSpace(base({ codedHeight: 1080 }), SD).colorSpace?.matrix).toBe("smpte170m");
    expect(withDefaultColorSpace(base({ codedWidth: 640, codedHeight: 360 }), HD).colorSpace?.matrix).toBe("bt709");
  });

  it("keeps a fully tagged decode target as it is", () => {
    const tagged = base({ colorSpace: { matrix: "smpte170m", primaries: "bt709", transfer: "bt709", fullRange: true } });
    expect(withDefaultColorSpace(tagged, HD)).toEqual(tagged);
  });

  it("lets each colr field win and fills only the ones it omits", () => {
    const partial = base({ colorSpace: { primaries: "bt470bg", fullRange: true } });
    expect(withDefaultColorSpace(partial, SD).colorSpace).toEqual({
      primaries: "bt470bg",
      fullRange: true,
      matrix: "smpte170m",
      transfer: "smpte170m",
    });
  });

  it("carries a full-range sourceColor", () => {
    const full = resolveSourceColor({ height: 1080, color_range: "pc" });
    expect(withDefaultColorSpace(base(), full).colorSpace?.fullRange).toBe(true);
  });
});

// A hardware decoder converts a stream that declares no matrix as BT.709,
// whatever the config says; only a software decoder follows the config.
describe("decodesInSoftwareForColour", () => {
  it("asks for software when the rule supplied a matrix other than BT.709", () => {
    expect(decodesInSoftwareForColour(SD)).toBe(true);
  });

  it("leaves hardware decode to a source the hardware reads the same way", () => {
    // An absent matrix read as BT.709 is what the hardware does anyway.
    expect(decodesInSoftwareForColour(HD)).toBe(false);
    // A declared matrix is in the bitstream, which the hardware follows.
    expect(decodesInSoftwareForColour(resolveSourceColor({ height: 480, color_matrix: "smpte170m" }))).toBe(false);
    expect(decodesInSoftwareForColour(resolveSourceColor({ height: 480, color_matrix: "bt709" }))).toBe(false);
  });
});
