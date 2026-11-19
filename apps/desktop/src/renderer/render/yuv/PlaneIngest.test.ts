import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BufferImageSource, DOMAdapter, type Renderer } from "pixi.js";
import { conversionUniforms, type IngestLayout } from "./PlaneIngest";
import { NV12_LAYOUT, Nv12Ingest } from "../nv12/Nv12Ingest";
import { TEN_BIT_LAYOUT, TenBitIngest } from "../tenbit/TenBitIngest";
import { BT2020_NCL, BT601, BT709, columnMajor, inverseCoef, primariesToBt709 } from "./colourConversion";
import { nv12FrameFromBytes, type NativeNv12Frame } from "../decoder/nv12Frame";
import { tenBitFrameFromBytes, type TenBitFrame } from "../decoder/tenBitFrame";
import type { ColourStamp } from "../decoder/ffprobeColorSpace";

/// Code points of the BT.709 / BT.2100 integer representation at 8 bits;
/// a higher bit depth scales them by 2^(bits − 8).
const NARROW_8 = { black: 16, white: 235, chromaMin: 16, chromaMax: 240 };

const LANES = [
  { lane: "NV12", layout: NV12_LAYOUT as IngestLayout<unknown>, bits: 8 },
  { lane: "10-bit", layout: TEN_BIT_LAYOUT as IngestLayout<unknown>, bits: 10 },
];

/// The shader's normalisation, read from what the layout feeds it.
function normalise(layout: IngestLayout<unknown>, fullRange: boolean, y: number, c: number) {
  const { scale, yOffset } = conversionUniforms(layout, { fullRange });
  return { y: (y - yOffset) / scale[0], c: (c - layout.chromaZero) / scale[1] };
}

describe("conversionUniforms", () => {
  it.each(LANES)("$lane limited range takes nominal black/white to 0/1 and the chroma extremes to ±0.5", ({ layout, bits }) => {
    const k = 2 ** (bits - 8);
    const lo = normalise(layout, false, NARROW_8.black * k, NARROW_8.chromaMin * k);
    const hi = normalise(layout, false, NARROW_8.white * k, NARROW_8.chromaMax * k);
    expect([lo.y, hi.y]).toEqual([0, 1]);
    expect([lo.c, hi.c]).toEqual([-0.5, 0.5]);
  });

  it.each(LANES)("$lane full range spans every code for luma and chroma alike", ({ layout, bits }) => {
    const max = 2 ** bits - 1;
    expect(normalise(layout, true, 0, 0).y).toBe(0);
    expect(normalise(layout, true, max, 0).y).toBe(1);
    const { scale } = conversionUniforms(layout, { fullRange: true });
    expect(scale[1]).toBe(scale[0]);
  });

  it.each(LANES)("$lane converts with the frame's stamped matrix, BT.709 when untagged", ({ layout }) => {
    expect(conversionUniforms(layout, { matrix: "smpte170m" }).coef).toEqual(inverseCoef(BT601));
    expect(conversionUniforms(layout, { matrix: "bt470bg" }).coef).toEqual(inverseCoef(BT601));
    expect(conversionUniforms(layout, { matrix: "bt709" }).coef).toEqual(inverseCoef(BT709));
    expect(conversionUniforms(layout, { matrix: "bt2020-ncl" }).coef).toEqual(inverseCoef(BT2020_NCL));
    expect(conversionUniforms(layout, null).coef).toEqual(inverseCoef(BT709));
  });

  it.each(LANES)("$lane converts BT.2020 and EBU primaries into BT.709, and no others", ({ layout }) => {
    for (const primaries of ["bt2020", "bt470bg"] as const) {
      expect(conversionUniforms(layout, { matrix: "bt709", primaries }).gamut, primaries)
        .toEqual(columnMajor(primariesToBt709(primaries)!));
    }
    for (const primaries of ["bt709", "smpte170m"] as const) {
      expect(conversionUniforms(layout, { matrix: "bt709", primaries }).gamut, primaries).toBeNull();
    }
    expect(conversionUniforms(layout, null).gamut).toBeNull();
  });

  it.each(LANES)("$lane converts an HDR frame with BT.709 coefficients and no primaries step", ({ layout }) => {
    for (const transfer of ["pq", "hlg"] as const) {
      const u = conversionUniforms(layout, { matrix: "bt2020-ncl", primaries: "bt2020", transfer });
      expect(u.coef, transfer).toEqual(inverseCoef(BT709));
      expect(u.gamut, transfer).toBeNull();
    }
  });
});

// Real Pixi with a stand-in renderer, as unbindOnDestroy.test.ts: the engine's
// plane sources, bindings and target are inspectable without a GPU.
describe("PlaneIngest planes", () => {
  const render = vi.fn();
  const renderer = { render } as unknown as Renderer;
  const ingests: { dispose(): void }[] = [];

  beforeEach(() => {
    // A GL program probes fragment precision on a test canvas; Node has none.
    vi.spyOn(DOMAdapter.get(), "createCanvas").mockReturnValue(
      { getContext: () => null } as unknown as HTMLCanvasElement,
    );
  });
  afterEach(() => {
    for (const ingest of ingests.splice(0)) ingest.dispose();
    render.mockClear();
    vi.restoreAllMocks();
  });

  /// The pass `textureFor` rendered: its plane sources by resource name, the
  /// WGSL bindings Pixi parsed, and the target.
  function lastPass() {
    const { container, target } = render.mock.lastCall![0];
    const shader = container.shader;
    const bound: string[] = shader.gpuProgram.structsAndGroups.groups
      .filter((g: { group: number }) => g.group === 2)
      .map((g: { name: string }) => g.name);
    // The accessor's properties are not enumerable: look up the bound names.
    const planes = Object.fromEntries(
      bound.map((name) => [name, shader.resources[name]])
        .filter(([, r]) => r instanceof BufferImageSource),
    ) as Record<string, BufferImageSource>;
    return {
      planes, bound, target,
      glFragment: shader.glProgram.fragment as string,
      wgsl: shader.gpuProgram.fragment.source as string,
      uniforms: shader.resources.yuv.uniforms as Record<string, unknown>,
    };
  }

  // 854 wide: w % 4 == 2, the width whose rows are not 4-aligned.
  const W = 854, H = 480;

  it("NV12 binds full-res R8 luma and half-res RG8 CbCr, tight at the frame's offsets", () => {
    const ingest = new Nv12Ingest(renderer);
    ingests.push(ingest);
    const f: NativeNv12Frame = nv12FrameFromBytes({
      data: new Uint8Array(W * H * 3 / 2), width: W, height: H,
      timestamp: 0, duration: null, colorSpace: null,
    });
    ingest.textureFor("clip", f);
    const { planes, bound, target, glFragment } = lastPass();
    expect(Object.keys(planes)).toEqual(["uY", "uUV"]);
    const { uY, uUV } = planes as { uY: BufferImageSource; uUV: BufferImageSource };
    expect([uY.format, uY.width, uY.height]).toEqual(["r8unorm", W, H]);
    expect([uUV.format, uUV.width, uUV.height]).toEqual(["rg8unorm", W / 2, H / 2]);
    expect((uY.resource as Uint8Array).byteOffset).toBe(0);
    expect((uY.resource as Uint8Array).byteLength).toBe(W * H);
    expect((uUV.resource as Uint8Array).byteOffset).toBe(f.uvOffset);
    expect((uUV.resource as Uint8Array).byteLength).toBe((W / 2) * (H / 2) * 2);
    for (const p of [uY, uUV]) expect(p.style.scaleMode, "sampled nearest").toBe("nearest");
    expect(bound).toEqual(["uY", "uYSampler", "uUV", "uUVSampler", "yuv"]);
    for (const name of ["uY", "uUV"]) expect(glFragment).toContain(`uniform sampler2D ${name};`);
    expect(target.source.format).toBe("rgba8unorm");
  });

  it("10-bit binds three RG8 planes, Y full-res and U, V half-res, tight at the frame's offsets", () => {
    const ingest = new TenBitIngest(renderer);
    ingests.push(ingest);
    const luma = W * H * 2, chroma = (W / 2) * (H / 2) * 2;
    const f: TenBitFrame = tenBitFrameFromBytes({
      data: new Uint8Array(luma + 2 * chroma), width: W, height: H,
      timestamp: 0, duration: null, colorSpace: null,
    });
    ingest.textureFor("clip", f);
    const { planes, bound, target, glFragment } = lastPass();
    expect(Object.keys(planes)).toEqual(["uY", "uU", "uV"]);
    const { uY, uU, uV } = planes as Record<"uY" | "uU" | "uV", BufferImageSource>;
    expect([uY.format, uY.width, uY.height]).toEqual(["rg8unorm", W, H]);
    for (const c of [uU, uV]) expect([c.format, c.width, c.height]).toEqual(["rg8unorm", W / 2, H / 2]);
    const views = [uY, uU, uV].map((p) => p.resource as Uint8Array);
    expect(views.map((v) => v.byteOffset)).toEqual([f.yOffset, f.uOffset, f.vOffset]);
    expect(views.map((v) => v.byteLength)).toEqual([luma, chroma, chroma]);
    for (const p of [uY, uU, uV]) expect(p.style.scaleMode, "sampled nearest").toBe("nearest");
    expect(bound).toEqual(["uY", "uYSampler", "uU", "uUSampler", "uV", "uVSampler", "yuv"]);
    for (const name of ["uY", "uU", "uV"]) expect(glFragment).toContain(`uniform sampler2D ${name};`);
    // The 10-bit export's f16 compositing depends on it (ADR 0022).
    expect(target.source.format).toBe("rgba16float");
  });

  /// A W x H NV12 frame stamped `colorSpace`.
  const nv12 = (colorSpace: NativeNv12Frame["colorSpace"]) => nv12FrameFromBytes({
    data: new Uint8Array(W * H * 3 / 2), width: W, height: H, timestamp: 0, duration: null, colorSpace,
  });

  it("runs a BT.709 frame through the variant without the primaries step", () => {
    const ingest = new Nv12Ingest(renderer);
    ingests.push(ingest);
    ingest.textureFor("clip", nv12({ matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false }));
    const { glFragment, wgsl, uniforms } = lastPass();
    for (const source of [glFragment, wgsl]) {
      expect(source).not.toContain("uGamut");
      expect(source).not.toContain("pow(");
    }
    expect(uniforms).not.toHaveProperty("uGamut");
  });

  /// Converts one frame stamped `colorSpace` through a fresh ingest of the lane.
  const lanes: { lane: string; convert: (colorSpace: ColourStamp) => void }[] = [
    {
      lane: "NV12",
      convert: (colorSpace) => {
        const ingest = new Nv12Ingest(renderer);
        ingests.push(ingest);
        ingest.textureFor("clip", nv12(colorSpace));
      },
    },
    {
      lane: "10-bit",
      convert: (colorSpace) => {
        const ingest = new TenBitIngest(renderer);
        ingests.push(ingest);
        ingest.textureFor("clip", tenBitFrameFromBytes({
          data: new Uint8Array(W * H * 2 + 2 * (W / 2) * (H / 2) * 2), width: W, height: H,
          timestamp: 0, duration: null, colorSpace,
        }));
      },
    },
  ];

  it.each(lanes)("$lane converts a BT.2020 frame into BT.709 primaries in both shader languages", ({ convert }) => {
    convert({ matrix: "bt2020-ncl", primaries: "bt2020", transfer: "bt709", fullRange: false });
    const { glFragment, wgsl, uniforms } = lastPass();
    expect(glFragment).toContain("uniform mat3 uGamut;");
    expect(glFragment).toContain("finalColor = vec4(clamp(toBt709(rgb), 0.0, 1.0), 1.0);");
    expect(wgsl).toContain("uGamut: mat3x3<f32>,");
    expect(wgsl).toContain("return vec4<f32>(clamp(toBt709(rgb), vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);");
    for (const source of [glFragment, wgsl]) expect(source).toContain("2.4");
    expect(uniforms.uGamut).toEqual(columnMajor(primariesToBt709("bt2020")!));
  });

  it("rebuilds a clip's pass when its frames change primaries", () => {
    const ingest = new Nv12Ingest(renderer);
    ingests.push(ingest);
    ingest.textureFor("clip", nv12({ matrix: "bt709", primaries: "bt709" }));
    const plain = render.mock.lastCall![0].container;
    ingest.textureFor("clip", nv12({ matrix: "bt709", primaries: "bt470bg" }));
    const converted = render.mock.lastCall![0].container;
    expect(converted).not.toBe(plain);
    expect(lastPass().uniforms.uGamut).toEqual(columnMajor(primariesToBt709("bt470bg")!));
  });
});
