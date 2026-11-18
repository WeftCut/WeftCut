// CPU-plane YUV frames → per-clip RGB textures through a Pixi mesh pass, the
// one engine behind every owned-shader ingest lane (ADR 0032). A lane is an
// `IngestLayout`: its planes, how its shader turns a texel into a code value,
// its range constants and its target format. The lanes: Nv12Ingest (8-bit
// NV12) and TenBitIngest (I420P10).
//
// Dual-backend (GLSL + WGSL): the export worker renders on WebGL, the preview
// compositor prefers WebGPU, and both ring CPU-plane frames, so the pass runs
// on whichever backend Pixi picked.

import {
  BufferImageSource, Mesh, MeshGeometry, Shader, type RenderTexture, type Texture,
} from "pixi.js";
import type { Renderer } from "pixi.js";
import { coefForMatrix, inverseCoef } from "../tenbit/yuv10";
import { unbindingRenderTexture } from "../unbindOnDestroy";

/// What the engine reads from a frame; each lane's frame type adds its plane
/// offsets, which only its `IngestPlane.bytes` reads.
export interface PlaneFrame {
  readonly width: number;
  readonly height: number;
  readonly colorSpace: VideoColorSpaceInit | null;
}

export interface IngestPlane<F> {
  /// The plane's sampler in both shader sources and its `resources` key; the
  /// WGSL sampler is `${name}Sampler`.
  readonly name: string;
  readonly format: "r8unorm" | "rg8unorm";
  /// 4:2:0 chroma: half the frame's width and height, rounded down.
  readonly subsampled: boolean;
  /// The plane's tightly packed rows within the frame.
  bytes(f: F): Uint8Array;
}

/// Offset and scales that take code values to normalised luma (0..1) and
/// chroma (−0.5..0.5) once the chroma zero is subtracted.
export interface CodeRange {
  readonly yOffset: number;
  readonly yScale: number;
  readonly cScale: number;
}

export interface IngestLayout<F> {
  readonly planes: readonly IngestPlane<F>[];
  /// GLSL ES 3.00 defining `vec3 yuvCodes(vec2 uv)`: the (Y, Cb, Cr) code
  /// values at `uv`, sampling the planes by name.
  ///
  /// LANDMINE: `glslCodes` and `wgslCodes` must decode identically, or the
  /// WebGL export and the WebGPU preview of the same frame silently differ.
  readonly glslCodes: string;
  /// WGSL defining `fn yuvCodes(uv: vec2<f32>) -> vec3<f32>`, as `glslCodes`.
  readonly wgslCodes: string;
  readonly limited: CodeRange;
  readonly full: CodeRange;
  /// The chroma code for zero colour difference. Both ranges share it, so it
  /// is a literal in the shader rather than a uniform.
  readonly chromaZero: number;
  readonly target: "rgba8unorm" | "rgba16float";
}

/// The conversion uniforms for one frame: matrix from the stamped
/// `colorSpace` (BT.709 when untagged, see `coefForMatrix`), range from its
/// `fullRange` flag (limited unless it says full).
export function conversionUniforms(
  layout: IngestLayout<unknown>,
  colorSpace: VideoColorSpaceInit | null | undefined,
): { coef: [number, number, number, number]; scale: [number, number]; yOffset: number } {
  const range = colorSpace?.fullRange === true ? layout.full : layout.limited;
  return {
    coef: inverseCoef(coefForMatrix(colorSpace?.matrix)),
    scale: [range.yScale, range.cScale],
    yOffset: range.yOffset,
  };
}

/// Texel size of `plane` for a `w`×`h` frame.
function planeSize(plane: IngestPlane<unknown>, w: number, h: number): [number, number] {
  return plane.subsampled ? [w >> 1, h >> 1] : [w, h];
}

const shaderFloat = (n: number): string => n.toFixed(1);

const GL_VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;

function glFragment(layout: IngestLayout<unknown>): string {
  return `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;
${layout.planes.map((p) => `uniform sampler2D ${p.name};`).join("\n")}
uniform vec4 uCoef;   // crR, cbG, crG, cbB
uniform vec2 uScale;  // y scale, c scale
uniform float uYOff;
${layout.glslCodes}
void main() {
  vec3 k = yuvCodes(vUV);
  float y = (k.x - uYOff) / uScale.x;
  vec2 c  = (k.yz - ${shaderFloat(layout.chromaZero)}) / uScale.y;
  vec3 rgb = vec3(
    y + uCoef.x * c.y,
    y - uCoef.z * c.y - uCoef.y * c.x,
    y + uCoef.w * c.x);
  finalColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;
}

// Groups follow Pixi v8's mesh-shader convention: globalUniforms@group(0) and
// localUniforms@group(1) are declared with exactly those variable names so the
// mesh pipe auto-assigns their bind groups; our resources live in group(2),
// matched to `resources` keys by name. Both backends apply the mesh-local
// uTransformMatrix (identity for the root-rendered ingest mesh); dropping it
// on one side would split the backends the day the mesh is transformed.
function wgsl(layout: IngestLayout<unknown>): string {
  const planeBindings = layout.planes.map((p, i) =>
    `@group(2) @binding(${2 * i}) var ${p.name}: texture_2d<f32>;
@group(2) @binding(${2 * i + 1}) var ${p.name}Sampler: sampler;`).join("\n");
  return /* wgsl */ `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}

struct YuvUniforms {
  uCoef: vec4<f32>,
  uScale: vec2<f32>,
  uYOff: f32,
}

@group(0) @binding(0) var<uniform> globalUniforms : GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms : LocalUniforms;

${planeBindings}
@group(2) @binding(${2 * layout.planes.length}) var<uniform> yuv : YuvUniforms;

struct VSOutput {
  @builtin(position) vPosition: vec4<f32>,
  @location(0) vUV: vec2<f32>,
}

@vertex
fn mainVert(
  @location(0) aPosition: vec2<f32>,
  @location(1) aUV: vec2<f32>,
) -> VSOutput {
  let mvp = globalUniforms.uProjectionMatrix
    * globalUniforms.uWorldTransformMatrix
    * localUniforms.uTransformMatrix;
  return VSOutput(
    vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0),
    aUV,
  );
}

${layout.wgslCodes}

@fragment
fn mainFrag(
  @location(0) vUVIn: vec2<f32>,
) -> @location(0) vec4<f32> {
  let k = yuvCodes(vUVIn);
  let y = (k.x - yuv.uYOff) / yuv.uScale.x;
  let c = (k.yz - vec2<f32>(${shaderFloat(layout.chromaZero)})) / yuv.uScale.y;
  let rgb = vec3<f32>(
    y + yuv.uCoef.x * c.y,
    y - yuv.uCoef.z * c.y - yuv.uCoef.y * c.x,
    y + yuv.uCoef.w * c.x);
  return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}`;
}

interface ClipState<F> {
  w: number; h: number;
  planes: BufferImageSource[];
  rt: RenderTexture;
  mesh: Mesh<MeshGeometry, Shader>;
  last: F | null;
}

function planeSource(
  data: Uint8Array, w: number, h: number, format: IngestPlane<unknown>["format"],
): BufferImageSource {
  return new BufferImageSource({
    resource: data, width: w, height: h, format,
    alphaMode: "no-premultiply-alpha",
    // LANDMINE: a 10-bit plane carries one u16LE sample in a texel's two
    // bytes; bilinear filtering would interpolate the bytes independently and
    // produce garbage. 8-bit chroma upsamples nearest too, so the lanes agree.
    scaleMode: "nearest",
  });
}

export class PlaneIngest<F extends PlaneFrame> {
  private states = new Map<string, ClipState<F>>();
  private readonly glFragment: string;
  private readonly wgsl: string;

  constructor(private renderer: Renderer, private layout: IngestLayout<F>) {
    // Plane rows are tightly packed, so not 4-aligned for w%4==2 sources
    // (854/1918-wide): NV12's Y and CbCr rows and the 10-bit chroma rows are
    // all `w` bytes. Pixi never touches UNPACK_ALIGNMENT; default 4 would skew
    // those uploads. WebGL-only: the WebGPU upload path (writeTexture) takes
    // an explicit tight bytesPerRow, no row padding.
    if ("gl" in renderer) {
      renderer.gl.pixelStorei(renderer.gl.UNPACK_ALIGNMENT, 1);
    }
    this.glFragment = glFragment(layout);
    this.wgsl = wgsl(layout);
  }

  /// Convert `f` (if not already current) and return the clip's texture in the
  /// layout's target format. Keyed by layerId; textures are ingest-owned
  /// (callers must not destroy them).
  textureFor(key: string, f: F): Texture {
    let s = this.states.get(key);
    if (s && (s.w !== f.width || s.h !== f.height)) {
      this.release(key);
      s = undefined;
    }
    if (!s) {
      s = this.build(f);
      this.states.set(key, s);
    }
    if (s.last !== f) {
      const { planes } = s;
      this.layout.planes.forEach((p, i) => { planes[i]!.resource = p.bytes(f); });
      for (const plane of planes) plane.update();
      const { coef, scale, yOffset } = conversionUniforms(this.layout, f.colorSpace);
      const u = s.mesh.shader!.resources.yuv.uniforms;
      u.uCoef = new Float32Array(coef);
      u.uScale = new Float32Array(scale);
      u.uYOff = yOffset;
      this.renderer.render({ container: s.mesh, target: s.rt });
      s.last = f;
    }
    return s.rt;
  }

  private build(f: F): ClipState<F> {
    const w = f.width, h = f.height;
    const planes = this.layout.planes.map((p) => {
      const [pw, ph] = planeSize(p, w, h);
      return planeSource(p.bytes(f), pw, ph, p.format);
    });
    const rt = unbindingRenderTexture({ width: w, height: h, format: this.layout.target });
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const resources: Record<string, unknown> = {};
    this.layout.planes.forEach((p, i) => {
      resources[p.name] = planes[i];
      resources[`${p.name}Sampler`] = planes[i]!.style;
    });
    const initial = conversionUniforms(this.layout, null);
    resources.yuv = {
      uCoef: { value: new Float32Array(initial.coef), type: "vec4<f32>" },
      uScale: { value: new Float32Array(initial.scale), type: "vec2<f32>" },
      uYOff: { value: initial.yOffset, type: "f32" },
    };
    const shader = Shader.from({
      gl: { vertex: GL_VERT, fragment: this.glFragment },
      gpu: {
        vertex: { entryPoint: "mainVert", source: this.wgsl },
        fragment: { entryPoint: "mainFrag", source: this.wgsl },
      },
      resources,
    });
    const mesh = new Mesh<MeshGeometry, Shader>({ geometry, shader });
    return { w, h, planes, rt, mesh, last: null };
  }

  release(key: string): void {
    const s = this.states.get(key);
    if (!s) return;
    const { geometry, shader } = s.mesh;
    s.mesh.destroy();
    geometry.destroy();
    shader?.destroy();
    s.rt.destroy(true);
    for (const plane of s.planes) plane.destroy();
    this.states.delete(key);
  }

  dispose(): void {
    for (const k of [...this.states.keys()]) this.release(k);
  }
}
