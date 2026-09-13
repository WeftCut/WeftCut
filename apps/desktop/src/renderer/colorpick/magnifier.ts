import { samplePatch, type FrameBuffer } from './pixel';

/** One reusable staging canvas per magnifier, shared by both pick surfaces. */
export function createMagnifier(canvas: HTMLCanvasElement): (buffer: FrameBuffer, x: number, y: number) => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const stage = document.createElement('canvas');
  stage.width = stage.height = 11;
  const stageCtx = stage.getContext('2d');
  return (buffer, x, y) => {
    if (!stageCtx) return;
    const patch = samplePatch(buffer, x, y, 5);
    stageCtx.putImageData(new ImageData(new Uint8ClampedArray(patch.pixels), 11, 11), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(stage, 0, 0, canvas.width, canvas.height);
    const cell = canvas.width / 11;
    ctx.lineWidth = 2; ctx.strokeStyle = '#000';
    ctx.strokeRect(5 * cell - 1, 5 * cell - 1, cell + 2, cell + 2);
    ctx.lineWidth = 1; ctx.strokeStyle = '#fff';
    ctx.strokeRect(5 * cell + .5, 5 * cell + .5, cell - 1, cell - 1);
  };
}

export function magnifierPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number): { x: number; y: number } {
  return { x: Math.max(0, Math.min(x + 18, viewportWidth - width - 4)),
    y: Math.max(0, Math.min(y + 18, viewportHeight - height - 4)) };
}
