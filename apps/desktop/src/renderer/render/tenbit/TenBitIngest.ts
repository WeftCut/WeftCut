// The 10-bit ingest lane: converts TenBitFrames (I420P10) in an owned shader.
// The pass itself is PlaneIngest's.

import type { Renderer } from "pixi.js";
import type { TenBitFrame } from "../decoder/tenBitFrame";
import { PlaneIngest, type IngestLayout } from "../yuv/PlaneIngest";

/// Y, U and V each as RG8 (r = low byte, g = high byte of the u16LE sample);
/// U and V at half resolution.
export const TEN_BIT_LAYOUT: IngestLayout<TenBitFrame> = {
  planes: [
    {
      name: "uY", format: "rg8unorm", subsampled: false,
      bytes: (f) => f.data.subarray(f.yOffset, f.yOffset + f.width * f.height * 2),
    },
    {
      name: "uU", format: "rg8unorm", subsampled: true,
      bytes: (f) => f.data.subarray(f.uOffset, f.uOffset + (f.width >> 1) * (f.height >> 1) * 2),
    },
    {
      name: "uV", format: "rg8unorm", subsampled: true,
      bytes: (f) => f.data.subarray(f.vOffset, f.vOffset + (f.width >> 1) * (f.height >> 1) * 2),
    },
  ],
  glslCodes: `float decode10(vec4 t) { return t.r * 255.0 + t.g * 255.0 * 256.0; }
vec3 yuvCodes(vec2 uv) {
  return vec3(decode10(texture(uY, uv)), decode10(texture(uU, uv)), decode10(texture(uV, uv)));
}`,
  wgslCodes: /* wgsl */ `fn decode10(t: vec4<f32>) -> f32 {
  return t.r * 255.0 + t.g * 255.0 * 256.0;
}

fn yuvCodes(uv: vec2<f32>) -> vec3<f32> {
  return vec3<f32>(
    decode10(textureSample(uY, uYSampler, uv)),
    decode10(textureSample(uU, uUSampler, uv)),
    decode10(textureSample(uV, uVSampler, uv)));
}`,
  limited: { yOffset: 64, yScale: 876, cScale: 896 },
  full: { yOffset: 0, yScale: 1023, cScale: 1023 },
  chromaZero: 512,
  // rgba16float: the 10-bit export's f16 compositing depends on it (ADR 0022).
  target: "rgba16float",
};

export class TenBitIngest extends PlaneIngest<TenBitFrame> {
  constructor(renderer: Renderer) {
    super(renderer, TEN_BIT_LAYOUT);
  }
}
