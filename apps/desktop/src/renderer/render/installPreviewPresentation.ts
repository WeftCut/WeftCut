import type { Application } from 'pixi.js';
import { installTimedPresent } from './previewPresentation';
import { setSlotFenceBackend, slotFenceBackendForRenderer } from './decoder/transports/slotFenceQueue';

/** Both the editor and calibration must fence on the device actually presenting. */
export function installPreviewPresentation(app: Application): void {
  setSlotFenceBackend(slotFenceBackendForRenderer(app.renderer));
  installTimedPresent(app);
}
