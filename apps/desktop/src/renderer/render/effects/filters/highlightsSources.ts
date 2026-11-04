// Brightness-range Highlights correction with fixed black and white endpoints.
// The tone selector blends Rec.709 luma and the peak channel. A peak-aware gain
// keeps positive adjustments inside gamut without changing channel ratios.
// Both backends share this calibration; alpha and amount-zero input are kept.
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
    vec3 rgb = clamp(src.rgb / src.a, 0.0, 1.0);
    float peak = max(rgb.r, max(rgb.g, rgb.b));
    float tone = mix(dot(rgb, vec3(0.2126, 0.7152, 0.0722)), peak, 0.5);
    float low = 0.45;
    if (tone <= low) {
        finalColor = src;
        return;
    }
    float t = (tone - low) / (1.0 - low);
    float mapped;
    if (amount < 0.0) {
        mapped = low + (1.0 - low) * (t + 1.6 * amount * t * t * (1.0 - t));
    } else {
        mapped = low + (1.0 - low) * (t + amount * pow(t, 1.25) * (1.0 - t));
    }
    float scale = min(mapped / tone, 1.0 / peak);
    finalColor = vec4(rgb * scale * src.a, src.a);
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
  let rgb = clamp(src.rgb / src.a, vec3<f32>(0.0), vec3<f32>(1.0));
  let peak = max(rgb.r, max(rgb.g, rgb.b));
  let tone = mix(dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722)), peak, 0.5);
  let low = 0.45;
  if (tone <= low) { return src; }
  let t = (tone - low) / (1.0 - low);
  var mapped: f32;
  if (amount < 0.0) {
    mapped = low + (1.0 - low) * (t + 1.6 * amount * t * t * (1.0 - t));
  } else {
    mapped = low + (1.0 - low) * (t + amount * pow(t, 1.25) * (1.0 - t));
  }
  let scale = min(mapped / tone, 1.0 / peak);
  return vec4<f32>(rgb * scale * src.a, src.a);
}
`;

export const HIGHLIGHTS_UNIFORM_DEFAULTS = { uAmount: 0 };
