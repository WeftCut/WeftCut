// The 8-bit NV12 ingest lane: converts NativeNv12Frames in an owned shader,
// selecting the YUV→RGB matrix from the frame's stamped colorSpace —
// Chromium's own buffer-frame conversion can't be trusted with it (why: see
// nv12Frame.ts). The pass itself is PlaneIngest's.

import type { Renderer } from "pixi.js";
import type { NativeNv12Frame } from "../decoder/nv12Frame";
import { PlaneIngest, type IngestLayout } from "../yuv/PlaneIngest";

/// Y as R8 at full resolution, interleaved CbCr as RG8 at half resolution.
export const NV12_LAYOUT: IngestLayout<NativeNv12Frame> = {
  planes: [
    {
      name: "uY", format: "r8unorm", subsampled: false,
      bytes: (f) => f.data.subarray(0, f.width * f.height),
    },
    {
      name: "uUV", format: "rg8unorm", subsampled: true,
      bytes: (f) => f.data.subarray(f.uvOffset, f.uvOffset + f.width * (f.height >> 1)),
    },
  ],
  glslCodes: `vec3 yuvCodes(vec2 uv) {
  return vec3(texture(uY, uv).r, texture(uUV, uv).rg) * 255.0;
}`,
  wgslCodes: /* wgsl */ `fn yuvCodes(uv: vec2<f32>) -> vec3<f32> {
  return vec3<f32>(
    textureSample(uY, uYSampler, uv).r,
    textureSample(uUV, uUVSampler, uv).rg) * 255.0;
}`,
  limited: { yOffset: 16, yScale: 219, cScale: 224 },
  full: { yOffset: 0, yScale: 255, cScale: 255 },
  chromaZero: 128,
  target: "rgba8unorm",
};

export class Nv12Ingest extends PlaneIngest<NativeNv12Frame> {
  constructor(renderer: Renderer) {
    super(renderer, NV12_LAYOUT);
  }
}
