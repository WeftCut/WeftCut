// apps/desktop/src/renderer/app/stillsSheet.ts
//
// `render_frames { sheet: true }`: the rendered stills laid out as one labelled
// contact sheet, so an agent reads a beat's span in one image. Each frame keeps
// its own pixels; the label sits above it, never over the picture.

export interface Still { t_us: number; width: number; height: number; jpeg: ArrayBuffer }

const LABEL_PX = 26;

export function sheetLayout(count: number, frameW: number, frameH: number, maxCols = 4) {
  const cols = Math.max(1, Math.min(maxCols, count));
  const rows = Math.max(1, Math.ceil(count / cols));
  return { cols, rows, width: cols * frameW, height: rows * (frameH + LABEL_PX), cell: (i: number) => ({ x: (i % cols) * frameW, y: Math.floor(i / cols) * (frameH + LABEL_PX) }) };
}

export const stillLabel = (tUs: number) => `${(tUs / 1e6).toFixed(2)} s`;

export async function composeStillsSheet(frames: readonly Still[], maxCols = 4): Promise<{ width: number; height: number; jpeg: ArrayBuffer }> {
  const w = frames[0]!.width, h = frames[0]!.height;
  const layout = sheetLayout(frames.length, w, h, maxCols);
  const canvas = new OffscreenCanvas(layout.width, layout.height);
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.fillStyle = "#1e1e1e";
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.font = "16px sans-serif";
  for (const [i, f] of frames.entries()) {
    const { x, y } = layout.cell(i);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(stillLabel(f.t_us), x + 8, y + 18);
    const bitmap = await createImageBitmap(new Blob([f.jpeg], { type: "image/jpeg" }));
    try {
      ctx.drawImage(bitmap, x, y + LABEL_PX, w, h);
    } finally {
      bitmap.close();
    }
  }
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return { width: layout.width, height: layout.height, jpeg: await blob.arrayBuffer() };
}
