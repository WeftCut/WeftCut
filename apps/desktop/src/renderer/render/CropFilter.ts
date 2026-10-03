import { defaultFilterVert, Filter, GlProgram, GpuProgram, Matrix, UniformGroup, type Sprite } from 'pixi.js';
import type { CropRect } from '../../shared/crop';
import { pinUniformBuffer, releaseUniformBuffer } from './effects/filters/uniformBufferResidency';

// Last filter, independent of the effects bypass. Mapping through the sprite
// matrix preserves source coordinates across proxy size, pivot, flips, Groups,
// filter padding and transition render targets. No video readback or mask RT.
const fragment = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform mat3 uCropMatrix;
uniform vec4 uCrop;
uniform vec4 uInputPixel;
void main() {
  vec2 p = (uCropMatrix * vec3(vTextureCoord, 1.0)).xy;
  vec2 aa = max(abs(uCropMatrix[0].xy) * uInputPixel.z + abs(uCropMatrix[1].xy) * uInputPixel.w, vec2(0.0000001));
  vec2 coverage = clamp(min(p - uCrop.xy, uCrop.zw - p) / aa + 0.5, 0.0, 1.0);
  finalColor = texture(uTexture, vTextureCoord) * coverage.x * coverage.y;
}`;
const source = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>, uInputPixel: vec4<f32>, uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>, uGlobalFrame: vec4<f32>, uOutputTexture: vec4<f32>,
};
struct CropUniforms { uCropMatrix: mat3x3<f32>, uCrop: vec4<f32> };
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> cropUniforms: CropUniforms;
struct VSOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  var p = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  p.x = p.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  p.y = p.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return VSOutput(vec4(p, 0.0, 1.0), aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw));
}
@fragment fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let p = (cropUniforms.uCropMatrix * vec3(uv, 1.0)).xy;
  let aa = max(abs(cropUniforms.uCropMatrix[0].xy) * gfu.uInputPixel.z + abs(cropUniforms.uCropMatrix[1].xy) * gfu.uInputPixel.w, vec2<f32>(0.0000001));
  let coverage = clamp(min(p - cropUniforms.uCrop.xy, cropUniforms.uCrop.zw - p) / aa + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
  return textureSample(uTexture, uSampler, uv) * coverage.x * coverage.y;
}`;

export class CropFilter extends Filter {
  private readonly cropUniforms: UniformGroup<{ uCropMatrix: { value: Matrix; type: 'mat3x3<f32>' }; uCrop: { value: Float32Array; type: 'vec4<f32>' } }>;
  constructor(private sprite: Sprite) {
    const cropUniforms = new UniformGroup({
      uCropMatrix: { value: new Matrix(), type: 'mat3x3<f32>' },
      uCrop: { value: new Float32Array([0, 0, 1, 1]), type: 'vec4<f32>' },
    });
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment, name: 'crop-filter' }),
      gpuProgram: GpuProgram.from({ vertex: { source, entryPoint: 'mainVertex' }, fragment: { source, entryPoint: 'mainFragment' } }),
      resources: { cropUniforms },
    });
    this.cropUniforms = cropUniforms;
  }
  sync(sprite: Sprite, crop: CropRect): this {
    this.sprite = sprite;
    this.cropUniforms.uniforms.uCrop.set([crop.x, crop.y, crop.x + crop.w, crop.y + crop.h]);
    return this;
  }
  override apply(...args: Parameters<Filter['apply']>): void {
    args[0].calculateSpriteMatrix(this.cropUniforms.uniforms.uCropMatrix, this.sprite);
    super.apply(...args);
    pinUniformBuffer(this.cropUniforms);
  }
  override destroy(destroyPrograms = false): void {
    releaseUniformBuffer(this.cropUniforms);
    super.destroy(destroyPrograms);
  }
}
