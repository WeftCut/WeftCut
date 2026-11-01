// Highlights uses an adjustment-strength percentage, not a promised pixel reduction.
// A rational shoulder starts at Rec.709 display-gamma luma 0.30 with identity
// value and slope. Darker tones stay unchanged at every strength, including -100.
// Negative strength compresses progressively brighter tones; positive strength
// opens them up. The curve is monotonic for the entire [-100,100] range.
// The 4.0 compression / 0.8 expansion limits calibrate this custom SDR control;
// these are not a claim to match Final Cut or another editor's private formula.
// Scaling RGB together preserves hue until the SDR gamut clips. Alpha is kept.
// Keep this module plain JavaScript: the GPU parity gate loads the same sources.

export const HIGHLIGHTS_FRAG_GL = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uAmount;

void main() {
    vec4 src = textureLod(uTexture, vTextureCoord, 0.0);
    float amount = clamp(uAmount * 0.01, -1.0, 1.0);
    if (amount == 0.0 || src.a < 0.0001) {
        finalColor = src;
        return;
    }
    vec3 rgb = src.rgb / src.a;
    float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    float low = 0.30;
    if (luma <= low) {
        finalColor = src;
        return;
    }
    float delta = luma - low;
    float position = delta / (1.0 - low);
    float curve = amount < 0.0 ? -4.0 * amount : -0.8 * amount;
    float mapped = low + delta / max(1.0 + curve * position, 0.0001);
    float scale = mapped / luma;
    vec3 adjusted = clamp(rgb * scale, 0.0, 1.0);
    finalColor = vec4(adjusted * src.a, src.a);
}
`;

export const HIGHLIGHTS_WGSL = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};
struct HighlightsUniforms { uAmount: f32, };
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> highlightsUniforms: HighlightsUniforms;
struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  let uv = aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
  return VSOutput(vec4<f32>(position, 0.0, 1.0), uv);
}
@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSampleLevel(uTexture, uSampler, uv, 0.0);
  let amount = clamp(highlightsUniforms.uAmount * 0.01, -1.0, 1.0);
  if (amount == 0.0 || src.a < 0.0001) { return src; }
  let rgb = src.rgb / src.a;
  let luma = dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  let low = 0.30;
  if (luma <= low) { return src; }
  let delta = luma - low;
  let position = delta / (1.0 - low);
  let curve = select(-0.8 * amount, -4.0 * amount, amount < 0.0);
  let mapped = low + delta / max(1.0 + curve * position, 0.0001);
  let scale = mapped / luma;
  let adjusted = clamp(rgb * scale, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(adjusted * src.a, src.a);
}
`;

export const HIGHLIGHTS_UNIFORM_DEFAULTS = { uAmount: 0 };
