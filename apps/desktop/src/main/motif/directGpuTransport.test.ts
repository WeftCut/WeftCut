import { afterEach, expect, it, vi } from 'vitest';
import type { OffscreenSharedTexture, WebContents } from 'electron';
const state = vi.hoisted(() => ({ released: vi.fn(), imports: vi.fn(), sends: vi.fn(), on: vi.fn(), off: vi.fn(), referenceRelease: undefined as (() => void) | undefined }));
vi.mock('../resources', () => ({ reserveResources: () => state.released }));
vi.mock('electron', () => ({ ipcMain: { on: state.on, removeListener: state.off }, sharedTexture: {
  importSharedTexture: (...args: unknown[]) => state.imports(...args),
  sendSharedTexture: (...args: unknown[]) => state.sends(...args),
} }));
import { copyDirectMotifTexture } from './directGpuTransport';
const owner = { isDestroyed: () => false, mainFrame: { isDestroyed: () => false, detached: false } } as unknown as WebContents;
const texture = { textureInfo: { pixelFormat: 'bgra', codedSize: { width: 32, height: 16 }, handle: { nativePixmap: {} } } } as OffscreenSharedTexture;
afterEach(() => vi.resetAllMocks());
it('holds the import until the receiver snapshots and fences, and accounts memory until all imports are released', async () => {
  let finish!: () => void;
  const releaseImport = vi.fn();
  state.imports.mockImplementation(({ allReferencesReleased }) => { state.referenceRelease = allReferencesReleased; return { release: releaseImport }; });
  state.sends.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const result = copyDirectMotifTexture(owner, texture, 42);
  await vi.waitFor(() => expect(state.sends).toHaveBeenCalledOnce());
  expect(releaseImport).not.toHaveBeenCalled();
  const metadata = state.sends.mock.calls[0][1];
  state.on.mock.calls[0][1]({ sender: owner, senderFrame: owner.mainFrame }, { token: metadata.token, value: true });
  finish();
  expect(await result).toMatchObject({ kind: 'bitmap' });
  expect(releaseImport).toHaveBeenCalledOnce();
  expect(state.off).toHaveBeenCalledOnce();
  expect(state.released).not.toHaveBeenCalled();
  state.referenceRelease!();
  expect(state.released).toHaveBeenCalledOnce();
});
it('releases failed imports and rejects unsupported surfaces without a format conversion', async () => {
  const release = vi.fn(() => state.referenceRelease?.());
  state.imports.mockImplementation(({ allReferencesReleased }) => { state.referenceRelease = allReferencesReleased; return { release }; });
  state.sends.mockRejectedValue(new Error('GPU import failed'));
  await expect(copyDirectMotifTexture(owner, texture, 42)).rejects.toThrow('GPU import failed');
  expect(release).toHaveBeenCalledOnce();
  expect(state.released).toHaveBeenCalledOnce();
  state.released.mockClear();
  await expect(copyDirectMotifTexture(owner, { textureInfo: { ...texture.textureInfo, pixelFormat: 'rgbaf16' } } as OffscreenSharedTexture)).rejects.toThrow('Unsupported');
  expect(state.released).not.toHaveBeenCalled();
});
it('does not accept another renderer receipt and releases a rejected consumer import', async () => {
  const releaseImport = vi.fn();
  state.imports.mockReturnValue({ release: releaseImport }); state.sends.mockResolvedValue(undefined);
  const result = copyDirectMotifTexture(owner, texture, 42);
  const rejected = expect(result).rejects.toThrow('receiver closed');
  await vi.waitFor(() => expect(state.sends).toHaveBeenCalledOnce());
  const token = state.sends.mock.calls[0][1].token, listener = state.on.mock.calls[0][1];
  listener({ sender: {}, senderFrame: owner.mainFrame }, { token, value: true });
  expect(releaseImport).not.toHaveBeenCalled();
  listener({ sender: owner, senderFrame: owner.mainFrame }, { token, error: 'receiver closed' });
  await rejected;
  expect(releaseImport).toHaveBeenCalledOnce(); expect(state.off).toHaveBeenCalledOnce();
});
