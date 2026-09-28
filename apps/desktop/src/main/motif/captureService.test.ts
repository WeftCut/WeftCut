import { describe, expect, it, vi } from 'vitest';
import type { OffscreenSharedTexture, WebContents } from 'electron';
import { MotifCaptureService, type CaptureServiceDeps } from './captureService';
import type { MotifFrameStore } from './frameStore';
import type { StoredMotifFrame } from '../../shared/motifs/frameTransport';

const owner = { id: 12 } as WebContents;
const args = { motifId: 'synthetic', tSec: 0, propsJson: '{}', width: 2, height: 2, settleRafs: 2, contentHash: 'v1', coalesceKey: 'job', high: false, bake: { hash: 'a'.repeat(32), frame: 0 } };
const texture = { textureInfo: { codedSize: { width: 2, height: 2 }, pixelFormat: 'bgra', handle: { ntHandle: Buffer.alloc(8) } } } as OffscreenSharedTexture;
function fixture(enabled = true) {
  const writer = { png: vi.fn(async () => {}), encoded: vi.fn(async () => {}) };
  const encoder = { encode: vi.fn(async () => Buffer.from('wfrm')), close: vi.fn() };
  const prepareWrite = vi.fn(async () => writer);
  const deps = {
    store: { prepareWrite } as unknown as MotifFrameStore,
    texture: vi.fn(async (_args: unknown, consume: (t: OffscreenSharedTexture) => Promise<StoredMotifFrame>) => consume(texture)),
    png: vi.fn(async () => Buffer.from('png').toString('base64')),
    copy: vi.fn(async () => ({ kind: 'texture' as const, key: 'pool', token: 'lease' })),
    createEncoder: vi.fn(() => encoder), setTextureEnabled: vi.fn(), isContentFailure: vi.fn(() => false),
  } satisfies CaptureServiceDeps;
  return { deps, writer, encoder, prepareWrite, service: new MotifCaptureService(deps, enabled) };
}

describe('Motif capture and persistence', () => {
  it('a baker joining while preview renders persists the same texture in its bound workspace', async () => {
    const h = fixture(); const { bake, ...preview } = args;
    let finish!: () => void;
    h.deps.texture.mockImplementation(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(texture);
    });
    const result = h.service.capture(owner, preview);
    h.service.requestBake(99, 'job', bake);
    expect(h.prepareWrite).not.toHaveBeenCalled();
    h.service.requestBake(owner.id, 'job', bake);
    expect(h.prepareWrite).toHaveBeenCalledExactlyOnceWith(bake.hash, bake.frame);
    finish();
    expect(await result).toMatchObject({ persisted: true });
    expect(h.encoder.encode).toHaveBeenCalledTimes(1);
    expect(h.deps.texture).toHaveBeenCalledTimes(1);
  });

  it('a bake joining after texture consumption uses bitmap persistence without recapture', async () => {
    const h = fixture(); const { bake, ...preview } = args;
    let finish!: () => void;
    h.deps.copy.mockImplementation(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { kind: 'texture', key: 'pool', token: 'lease' };
    });
    const result = h.service.capture(owner, preview);
    h.service.requestBake(owner.id, 'job', bake);
    finish();
    expect(await result).toMatchObject({ persisted: false });
    expect(h.prepareWrite).not.toHaveBeenCalled();
    expect(h.encoder.encode).not.toHaveBeenCalled();
    expect(h.deps.texture).toHaveBeenCalledTimes(1);
  });

  it('native bake completes its write before acknowledging persistence and delivering pixels', async () => {
    const h = fixture(); let finish!: () => void;
    h.writer.encoded.mockReturnValue(new Promise<void>(r => { finish = r; }));
    const result = h.service.capture(owner, args);
    await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalled());
    expect(h.deps.copy).not.toHaveBeenCalled();
    finish();
    expect(await result).toMatchObject({ kind: 'texture', persisted: true });
    expect(h.deps.png).not.toHaveBeenCalled(); expect(h.writer.png).not.toHaveBeenCalled();
    expect(h.deps.texture).toHaveBeenCalledWith(expect.anything(), expect.any(Function), '12:job', false);
  });

  it('without a GPU persists the captured PNG directly and retains alpha bytes for delivery', async () => {
    const h = fixture(false);
    expect(await h.service.capture(owner, args)).toEqual({ kind: 'png', bytes: Buffer.from('png'), persisted: true });
    expect(h.writer.png).toHaveBeenCalledExactlyOnceWith(Buffer.from('png'));
    expect(h.deps.texture).not.toHaveBeenCalled(); expect(h.encoder.encode).not.toHaveBeenCalled();
  });

  it('failed native readback keeps the same capture for the compatibility writer', async () => {
    const h = fixture(); h.encoder.encode.mockRejectedValue(new Error('device unavailable'));
    expect(await h.service.capture(owner, args)).toMatchObject({ kind: 'texture', persisted: false });
    expect(await h.service.capture(owner, args)).toMatchObject({ kind: 'texture', persisted: false });
    expect(h.encoder.encode).toHaveBeenCalledTimes(1);
    expect(h.encoder.close).toHaveBeenCalledTimes(1);
    expect(h.deps.png).not.toHaveBeenCalled(); expect(h.writer.encoded).not.toHaveBeenCalled();
  });

  it('a disk error cannot become a ready frame or disable a healthy GPU', async () => {
    const h = fixture(); h.writer.encoded.mockRejectedValue(new Error('disk full'));
    await expect(h.service.capture(owner, args)).rejects.toThrow('disk full');
    expect(h.deps.png).not.toHaveBeenCalled(); expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('GPU capture failure falls back to PNG and persists the fallback', async () => {
    const h = fixture(); h.deps.texture.mockRejectedValue(new Error('OSR unavailable'));
    expect(await h.service.capture(owner, args)).toMatchObject({ kind: 'png', persisted: true });
    expect(h.deps.setTextureEnabled).toHaveBeenLastCalledWith(false);
    await h.service.capture(owner, args);
    expect(h.deps.texture).toHaveBeenCalledTimes(1);
  });

  it('content errors and superseded requests do not trigger recapture', async () => {
    const h = fixture(); h.deps.isContentFailure.mockReturnValue(true);
    h.deps.texture.mockRejectedValue(new Error('broken motif'));
    await expect(h.service.capture(owner, args)).rejects.toThrow('broken motif');
    expect(h.deps.png).not.toHaveBeenCalled();
    expect(h.writer.encoded).not.toHaveBeenCalled();
  });

  it('preview never writes a cache file', async () => {
    const h = fixture(); const { bake: _bake, ...preview } = args;
    expect(await h.service.capture(owner, preview)).toMatchObject({ persisted: false });
    expect(h.prepareWrite).not.toHaveBeenCalled(); expect(h.encoder.encode).not.toHaveBeenCalled();
  });
});
