import type { Application } from 'pixi.js';
import { installTimedPresent } from './previewPresentation';
import { setSlotFenceBackend, slotFenceBackendForRenderer } from './decoder/transports/slotFenceQueue';
import { dropCopiesOnceLost, webgpuDeviceOf } from './webgpuDevice';

/** Both the editor and calibration must fence on the device actually presenting:
 * the one Pixi starts with, and each one its restore creates after a device loss
 * (`contextChange`). Every such device stops taking copies once lost. */
export function installPreviewPresentation(app: Application): void {
  const adoptDevice = (): void => {
    const device = webgpuDeviceOf(app.renderer);
    if (device) dropCopiesOnceLost(device);
    setSlotFenceBackend(slotFenceBackendForRenderer(app.renderer));
  };
  adoptDevice();
  app.renderer.runners.contextChange.add({ contextChange: adoptDevice });
  installTimedPresent(app);
}
