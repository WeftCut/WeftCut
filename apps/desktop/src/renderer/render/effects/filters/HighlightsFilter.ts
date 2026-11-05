import { defaultFilterVert, Filter, GlProgram, GpuProgram, UniformGroup } from "pixi.js";
import { HIGHLIGHTS_FRAG_GL, HIGHLIGHTS_WGSL, HIGHLIGHTS_UNIFORM_DEFAULTS } from "./highlightsSources";
import { pinUniformBuffer, releaseUniformBuffer } from "./uniformBufferResidency";

export class HighlightsFilter extends Filter {
  private readonly highlightsUniforms: UniformGroup;

  constructor() {
    const highlightsUniforms = new UniformGroup({
      uAmount: { value: HIGHLIGHTS_UNIFORM_DEFAULTS.uAmount, type: "f32" },
    });
    super({
      gpuProgram: GpuProgram.from({
        vertex: { source: HIGHLIGHTS_WGSL, entryPoint: "mainVertex" },
        fragment: { source: HIGHLIGHTS_WGSL, entryPoint: "mainFragment" },
      }),
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: HIGHLIGHTS_FRAG_GL, name: "highlights-filter" }),
      resources: { highlightsUniforms },
    });
    this.highlightsUniforms = highlightsUniforms;
  }

  override apply(...args: Parameters<Filter["apply"]>): void {
    super.apply(...args);
    pinUniformBuffer(this.highlightsUniforms);
  }

  override destroy(destroyPrograms = false): void {
    releaseUniformBuffer(this.highlightsUniforms);
    super.destroy(destroyPrograms);
  }

  applyAmount(amount: number): void {
    const u = this.highlightsUniforms.uniforms as { uAmount: number };
    u.uAmount = amount;
  }
}
