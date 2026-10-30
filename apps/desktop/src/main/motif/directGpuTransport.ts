import { randomUUID } from 'node:crypto';
import { ipcMain, sharedTexture, type OffscreenSharedTexture, type WebContents, type IpcMainEvent } from 'electron';
import { withSharedTextureQueue } from '../sharedTextureQueue';
import { reserveResources } from '../resources';
import type { MotifBitmapFrame } from '../../shared/motifs/frameTransport';

/** Import a Linux OSR surface directly, snapshot it on the consumer GPU, then
 * wait for the receiver's read-completion barrier before recycling the source.
 * No native D3D pool, full-frame CPU readback, PNG or Base64 is involved. */
function receipt<T>(owner: WebContents, token: string, send: () => Promise<void> | void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let value: T, received = false, sent = false;
    const finish = () => { if (received && sent) { cleanup(); resolve(value); } };
    const cleanup = () => { clearTimeout(timer); ipcMain.removeListener('motif:gpu-frame-result', listener); };
    const listener = (event: IpcMainEvent, result: { token?: string; error?: string; value: T }) => {
      if (event.sender !== owner || owner.isDestroyed() || event.senderFrame !== owner.mainFrame || result?.token !== token) return;
      if (result.error) { cleanup(); reject(new Error(result.error)); return; }
      value = result.value; received = true; finish();
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Motif GPU receiver unavailable')); }, 2000);
    ipcMain.on('motif:gpu-frame-result', listener);
    Promise.resolve().then(send).then(() => { sent = true; finish(); }, error => { cleanup(); reject(error); });
  });
}

async function transfer(owner: WebContents, texture: OffscreenSharedTexture, parent?: number, probe?: { referencePng?: string }): Promise<{ token: string; quality: boolean }> {
  const info = texture.textureInfo;
  if ((info.pixelFormat !== 'rgba' && info.pixelFormat !== 'bgra') || !info.handle.nativePixmap) throw new Error('Unsupported Linux Motif shared texture');
  const release = reserveResources(0, 16 + info.codedSize.width * info.codedSize.height * 4 / 1048576, parent);
  return withSharedTextureQueue(async () => {
    if (owner.isDestroyed() || owner.mainFrame.isDestroyed() || owner.mainFrame.detached) { release(); throw new Error('Motif consumer closed'); }
    let imported: ReturnType<typeof sharedTexture.importSharedTexture> | undefined;
    try {
      imported = sharedTexture.importSharedTexture({ textureInfo: info, allReferencesReleased: release });
      const token = randomUUID();
      const quality = await receipt<boolean>(owner, token, () => sharedTexture.sendSharedTexture(
        { frame: owner.mainFrame, importedSharedTexture: imported! }, { kind: 'motif-export-snapshot', token, ...(probe ? { probe } : {}) }));
      return { token, quality };
    } catch (error) {
      if (!imported) release();
      throw error;
    } finally { imported?.release(); }
  });
}

export async function copyDirectMotifTexture(owner: WebContents, texture: OffscreenSharedTexture, parent?: number): Promise<MotifBitmapFrame> {
  return { kind: 'bitmap', token: (await transfer(owner, texture, parent)).token };
}
export async function probeDirectMotifTexture(owner: WebContents, texture: OffscreenSharedTexture, parent?: number, referencePng?: string): Promise<boolean> {
  return (await transfer(owner, texture, parent, { referencePng })).quality;
}
export async function probeMotifPngDelivery(owner: WebContents, base64: string): Promise<void> {
  const token = randomUUID();
  await receipt<boolean>(owner, token, () => owner.send('motif:gpu-probe-png', { token, base64 }));
}
