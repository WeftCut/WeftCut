import type { ScreenPickOverlayApi } from '../../shared/screenPick';
import { sampleHex, type FrameBuffer } from './pixel';
import { createMagnifier, magnifierPosition } from './magnifier';
import { desktopPoint } from './desktopPoint';
import './desktopOverlay.css';

const api = (window as unknown as { screenPicker: ScreenPickOverlayApi }).screenPicker;

async function mount(): Promise<void> {
  const data = await api.snapshot();
  if (Math.abs(devicePixelRatio - data.scaleFactor) > .01) throw new Error('Display scale changed during capture');
  const bitmap = await createImageBitmap(new Blob([data.png], { type: 'image/png' }));
  const canvas = document.querySelector<HTMLCanvasElement>('#desktop')!;
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  // Actual capture dimensions are authoritative; integer DIP bounds may be
  // off by one at 110% scaling. Never stretch the frozen screenshot to fit.
  const width = bitmap.width / devicePixelRatio, height = bitmap.height / devicePixelRatio;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) { bitmap.close(); throw new Error('No sampling context'); }
  ctx.drawImage(bitmap, 0, 0); bitmap.close();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const buffer: FrameBuffer = { pixels: pixels.data, width: pixels.width, height: pixels.height };
  const mag = document.querySelector<HTMLDivElement>('#magnifier')!;
  const hex = document.querySelector<HTMLSpanElement>('#hex')!;
  const draw = createMagnifier(document.querySelector<HTMLCanvasElement>('#zoom')!);
  document.querySelector<HTMLDivElement>('#hint')!.textContent = data.hint;
  let point: { x: number; y: number } | null = null;
  let raf: number | null = null;
  let lastHex = '';
  let done = false;
  const finish = (value: string | null): void => {
    if (done) return;
    done = true;
    if (raf !== null) cancelAnimationFrame(raf);
    api.finish(value);
  };
  const update = (): void => {
    raf = null;
    if (done) return;
    mag.hidden = !point;
    if (!point) return;
    const value = sampleHex(buffer, point.x, point.y);
    hex.textContent = value;
    draw(buffer, point.x, point.y);
    const position = magnifierPosition(point.x / devicePixelRatio, point.y / devicePixelRatio,
      mag.offsetWidth, mag.offsetHeight, Math.min(innerWidth, width), Math.min(innerHeight, height));
    mag.style.left = `${position.x}px`; mag.style.top = `${position.y}px`;
    if (value !== lastHex) { lastHex = value; api.hover(value); }
  };
  window.addEventListener('pointermove', event => {
    point = desktopPoint(event.clientX, event.clientY, devicePixelRatio, buffer.width, buffer.height);
    if (raf === null) raf = requestAnimationFrame(update);
  });
  window.addEventListener('pointerout', event => {
    if (event.relatedTarget !== null) return;
    // Each display has its own window: crossing screens sends an exit, not
    // an out-of-bounds move. Hide immediately, even if painting is suspended.
    point = null;
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
    mag.hidden = true;
    // Another screen may have changed the preview before we enter again.
    lastHex = '';
  });
  window.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    point = desktopPoint(event.clientX, event.clientY, devicePixelRatio, buffer.width, buffer.height);
    update();
  });
  // Use the precise pointerdown position. click's integer CSS coordinates can
  // select the neighbouring pixel at fractional display scaling.
  window.addEventListener('click', () => {
    if (point) finish(sampleHex(buffer, point.x, point.y));
  });
  window.addEventListener('contextmenu', event => event.preventDefault());
  window.addEventListener('keydown', event => {
    event.preventDefault();
    if (event.key === 'Escape') { finish(null); return; }
    if (!point) return;
    if (event.key === 'Enter') { finish(sampleHex(buffer, point.x, point.y)); return; }
    const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as const)[event.key as 'ArrowLeft'];
    if (delta) {
      point = { x: Math.max(0, Math.min(buffer.width - 1, point.x + delta[0])),
        y: Math.max(0, Math.min(buffer.height - 1, point.y + delta[1])) };
      update();
    }
  });
  // Ready means decoded pixels and installed input handlers. A show:false
  // Electron window can withhold animation frames even with throttling off.
  // Waiting for one here deadlocks with main, which waits for ready to show us.
  api.ready();
}
void mount().catch(error => { console.warn('Desktop color picker:', error); api.failed(); });
