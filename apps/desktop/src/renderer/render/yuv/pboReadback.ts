// Batched GPU readback for the pack passes, shared by PackYuvPlanar and
// PackYuv420p10 so both packers read back the same way. readPixels lands in a
// PIXEL_PACK_BUFFER without stalling; drain() copies every pending buffer out
// in submission order, so one wait for the GPU serves the whole batch.

export interface PboPlane {
  /// readPixels dimensions in texels (RGBA8 → w*4 bytes per GPU row).
  w: number;
  h: number;
  /// VALID bytes per output row. When < w*4 the GPU row is padded and the
  /// copy-out trims each row (PackYuvPlanar's W % samplesPerTexel != 0 case).
  dstRowBytes: number;
  /// Copy rows bottom-up into the output (PackYuv420p10's PACK_ROW_FLIP).
  flipRows?: boolean;
}

export class PboFrameReader {
  private pbos: WebGLBuffer[] = [];
  /// Submitted frames not yet drained: indices into `pbos`, oldest first.
  private queue: number[] = [];
  private scratch: Uint8Array | null = null;
  private readonly pboBytes: number;
  private readonly frameBytes: number;
  /// Byte offsets accumulated in plane order: where readPixels writes in the
  /// PBO (padded rows) vs. where the plane lands in the output (valid rows).
  private readonly pboOffsets: number[] = [];
  private readonly dstOffsets: number[] = [];

  /// `depth` frames may be submitted before a drain (the plan's `readbackFrames`).
  constructor(
    private gl: WebGL2RenderingContext,
    private planes: PboPlane[],
    private readonly depth: number,
  ) {
    let pbo = 0;
    let dst = 0;
    for (const p of planes) {
      this.pboOffsets.push(pbo);
      this.dstOffsets.push(dst);
      pbo += p.w * 4 * p.h;
      dst += p.dstRowBytes * p.h;
    }
    this.pboBytes = pbo;
    this.frameBytes = dst;
  }

  /// Every buffer holds a submitted frame: drain before the next submit.
  get full(): boolean {
    return this.queue.length >= this.depth;
  }

  /// Queue one frame's readback: for each plane, `bindPlane(i)` must bind that
  /// plane's framebuffer (the pack pass RT), then readPixels streams it into
  /// the next free PBO.
  submit(bindPlane: (index: number) => void): void {
    const gl = this.gl;
    if (this.full) throw new Error("PboFrameReader: every readback buffer is pending — drain() first");
    const idx = this.queue.length;
    if (idx === this.pbos.length) {
      const pbo = gl.createBuffer();
      if (!pbo) throw new Error("PboFrameReader: createBuffer failed");
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.pboBytes, gl.STREAM_READ);
      this.pbos.push(pbo);
    } else {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbos[idx]!);
    }
    for (let i = 0; i < this.planes.length; i++) {
      const p = this.planes[i]!;
      bindPlane(i);
      gl.readPixels(0, 0, p.w, p.h, gl.RGBA, gl.UNSIGNED_BYTE, this.pboOffsets[i]!);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    // Start the copies now so they run while later frames composite.
    gl.flush();
    this.queue.push(idx);
  }

  /// Every submitted frame, oldest first, each in a fresh exactly-sized buffer
  /// the caller owns (it can transfer it without a copy). getBufferSubData
  /// waits only for the GPU work it reads; GL ordering makes each buffer hold
  /// its own frame.
  ///
  /// LANDMINE: no fence. Chromium updates a fence's status only at frame
  /// boundaries, so polling one costs up to a display frame per readback,
  /// however early the GPU finished.
  drain(): Uint8Array[] {
    const gl = this.gl;
    const frames: Uint8Array[] = [];
    for (const idx of this.queue) {
      const out = new Uint8Array(this.frameBytes);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbos[idx]!);
      for (let i = 0; i < this.planes.length; i++) {
        const p = this.planes[i]!;
        const gpuRow = p.w * 4;
        const dstOff = this.dstOffsets[i]!;
        if (!p.flipRows && p.dstRowBytes === gpuRow) {
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, this.pboOffsets[i]!, out, dstOff, gpuRow * p.h);
          continue;
        }
        // Padded or flipped plane: land the GPU rows in scratch, then place each
        // row's valid bytes individually.
        const need = gpuRow * p.h;
        if (!this.scratch || this.scratch.length < need) this.scratch = new Uint8Array(need);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, this.pboOffsets[i]!, this.scratch, 0, need);
        for (let r = 0; r < p.h; r++) {
          const dstRow = p.flipRows ? p.h - 1 - r : r;
          out.set(
            this.scratch.subarray(r * gpuRow, r * gpuRow + p.dstRowBytes),
            dstOff + dstRow * p.dstRowBytes,
          );
        }
      }
      frames.push(out);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (gl.isContextLost()) throw new Error("PboFrameReader: WebGL context lost during readback");
    this.queue = [];
    return frames;
  }

  dispose(): void {
    for (const pbo of this.pbos) this.gl.deleteBuffer(pbo);
    this.pbos = [];
    this.queue = [];
    this.scratch = null;
  }
}
