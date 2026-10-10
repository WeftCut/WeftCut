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
  const read = vi.fn(async (): Promise<StoredMotifFrame | null> => ({ kind: 'rgba', width: 2, height: 2, rgba: new Uint8Array(16) }));
  const deps = {
    store: { prepareWrite, read } as unknown as MotifFrameStore,
    texture: vi.fn(async (_args: unknown, consume: (t: OffscreenSharedTexture) => Promise<StoredMotifFrame>) => consume(texture)),
    png: vi.fn(async () => Buffer.from('png').toString('base64')),
    copy: vi.fn(async () => ({ kind: 'texture' as const, key: 'pool', token: 'lease' })),
    createEncoder: vi.fn(() => encoder), setTextureEnabled: vi.fn(), isContentFailure: vi.fn(() => false),
    promote: vi.fn(),
  } satisfies CaptureServiceDeps;
  return { deps, writer, encoder, prepareWrite, read, service: new MotifCaptureService(deps, enabled) };
}

describe('Motif capture and persistence', () => {
  it('does not deliver an old document capture to its replacement or disable GPU capture', async () => {
    const h = fixture(); const { bake: _bake, ...preview } = args;
    let current = true;
    let finish!: () => void;
    h.deps.texture.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(texture);
    });
    const result = h.service.capture(owner, preview, () => current);
    current = false;
    finish();
    await expect(result).rejects.toThrow('superseded');
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.deps.png).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(await h.service.capture(owner, preview)).toMatchObject({ kind: 'texture' });
  });

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
    expect(h.deps.texture).toHaveBeenCalledWith(expect.anything(), expect.any(Function), '12:job', false, expect.any(Function));
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

  it('persists without a renderer owner, GPU copy, or pixel delivery', async () => {
    const h = fixture();
    await expect(h.service.persist(args)).resolves.toBeUndefined();
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(Buffer.from('wfrm'));
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.deps.png).not.toHaveBeenCalled();
  });

  it('persists through PNG without shared texture support', async () => {
    const h = fixture(false);
    await h.service.persist(args);
    expect(h.writer.png).toHaveBeenCalledExactlyOnceWith(Buffer.from('png'));
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.deps.texture).not.toHaveBeenCalled();
  });

  it('native persistence does not require a display texture transport adapter', async () => {
    const h = fixture();
    const service = new MotifCaptureService({ ...h.deps, copy: null }, true);
    await service.persist(args);
    expect(h.writer.encoded).toHaveBeenCalledTimes(1);
    expect(h.deps.png).not.toHaveBeenCalled();
    const { bake: _bake, ...preview } = args;
    await expect(service.capture(owner, preview)).resolves.toMatchObject({ kind: 'png', persisted: false });
  });

  it('readback failure falls back in main while display texture transport stays enabled', async () => {
    const h = fixture(); h.encoder.encode.mockRejectedValue(new Error('device unavailable'));
    await h.service.persist(args);
    await h.service.persist({ ...args, tSec: 1, bake: { ...args.bake, frame: 1 } });
    expect(h.deps.texture).toHaveBeenCalledTimes(1);
    expect(h.encoder.encode).toHaveBeenCalledTimes(1);
    expect(h.encoder.close).toHaveBeenCalledTimes(1);
    expect(h.writer.png).toHaveBeenCalledTimes(2);
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('persistence disk failure stays an error without recapture or disabling GPU', async () => {
    const h = fixture(); h.writer.encoded.mockRejectedValue(new Error('disk full'));
    await expect(h.service.persist(args)).rejects.toThrow('disk full');
    expect(h.deps.png).not.toHaveBeenCalled();
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('already-cancelled persistence performs no capture or disk work', async () => {
    const h = fixture();
    await expect(h.service.persist(args, () => false)).rejects.toThrow('superseded');
    expect(h.prepareWrite).not.toHaveBeenCalled();
    expect(h.deps.texture).not.toHaveBeenCalled();
    expect(h.deps.png).not.toHaveBeenCalled();
  });

  it('cancellation during capture performs no encoding or disk work', async () => {
    const h = fixture(); let current = true; let finish!: () => void;
    h.deps.texture.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(texture);
    });
    const result = h.service.persist(args, () => current);
    current = false; finish();
    await expect(result).rejects.toThrow('superseded');
    expect(h.prepareWrite).not.toHaveBeenCalled();
    expect(h.encoder.encode).not.toHaveBeenCalled();
  });

  it('concurrent persistence and display share a capture then read the persisted pixels', async () => {
    const h = fixture(); let finish!: () => void;
    h.writer.encoded.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const persist = h.service.persist(args);
    const duplicate = h.service.persist(args);
    const { bake: _bake, ...preview } = args;
    const display = h.service.capture(owner, preview);
    await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledTimes(1));
    expect(h.read).not.toHaveBeenCalled();
    finish();
    await Promise.all([persist, duplicate]);
    await expect(display).resolves.toMatchObject({ kind: 'rgba', persisted: true });
    expect(h.deps.texture).toHaveBeenCalledTimes(1);
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledExactlyOnceWith(args.bake.hash, args.bake.frame);
  });

  it('a persistence demand joins an existing display before consumption', async () => {
    const h = fixture(); let finish!: () => void;
    h.deps.texture.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(texture);
    });
    const { bake: _bake, ...preview } = args;
    const display = h.service.capture(owner, preview);
    const persist = h.service.persist(args);
    finish();
    await expect(display).resolves.toMatchObject({ persisted: true });
    await expect(persist).resolves.toBeUndefined();
    expect(h.deps.texture).toHaveBeenCalledTimes(1);
    expect(h.writer.encoded).toHaveBeenCalledTimes(1);
    expect(h.deps.copy).toHaveBeenCalledTimes(1);
  });

  it('rechecks a committed cache address when a display miss arrives after persistence completed', async () => {
    const h = fixture(false);
    await h.service.persist(args);
    // The renderer observed a hole before the background write, but its
    // foreground request reaches main after the pending job was removed.
    const { bake, ...preview } = args;
    const display = await h.service.capture(owner, { ...preview, cache: bake });
    expect(display).toMatchObject({ kind: 'rgba', persisted: true });
    expect(h.deps.png).toHaveBeenCalledTimes(1);
    expect(h.writer.png).toHaveBeenCalledTimes(1);
  });

  it('shares a display cache recheck with persistence that arrives during the read', async () => {
    const h = fixture(false);
    let finish!: (value: StoredMotifFrame | null) => void;
    h.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { bake, ...preview } = args;
    const display = h.service.capture(owner, { ...preview, cache: bake });
    const persist = h.service.persist(args);
    await Promise.resolve();
    expect(h.deps.png).not.toHaveBeenCalled();
    finish(null);
    await expect(display).resolves.toMatchObject({ persisted: true });
    await persist;
    expect(h.deps.png).toHaveBeenCalledTimes(1);
    expect(h.writer.png).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge another cache address as persisted when a bake joins a cache hit', async () => {
    const h = fixture(false);
    let finish!: (value: StoredMotifFrame | null) => void;
    h.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { bake, ...preview } = args;
    const display = h.service.capture(owner, { ...preview, cache: bake });
    const other = { hash: 'b'.repeat(32), frame: 0 };
    const persist = h.service.persist({ ...args, bake: other });
    finish({ kind: 'rgba', width: 2, height: 2, rgba: new Uint8Array(16) });
    await Promise.all([display, persist]);
    expect(h.prepareWrite).toHaveBeenCalledExactlyOnceWith(other.hash, other.frame);
    expect(h.writer.png).toHaveBeenCalledTimes(1);
  });

  it('cancelling background interest preserves a joined current display consumer', async () => {
    const h = fixture(); let finish!: () => void; let backgroundCurrent = true;
    h.deps.texture.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(texture);
    });
    const persist = h.service.persist(args, () => backgroundCurrent);
    const rejected = expect(persist).rejects.toThrow('superseded');
    const { bake: _bake, ...preview } = args;
    const display = h.service.capture(owner, preview);
    backgroundCurrent = false; finish();
    await rejected;
    await expect(display).resolves.toMatchObject({ kind: 'rgba', persisted: true });
    expect(h.deps.texture).toHaveBeenCalledTimes(1);
    expect(h.writer.encoded).toHaveBeenCalledTimes(1);
  });

  it('a foreground display promotes the queued shared background capture', async () => {
    const h = fixture(); let finish!: () => void;
    h.deps.texture.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(texture);
    });
    const persist = h.service.persist(args);
    const { bake: _bake, ...preview } = args;
    const display = h.service.capture(owner, { ...preview, high: true });
    expect(h.deps.promote).toHaveBeenCalledExactlyOnceWith('job');
    finish(); await persist; await display;
    expect(h.deps.texture).toHaveBeenCalledTimes(1);
  });

  it('workspace sessions do not share pending persistence acknowledgements', async () => {
    const h = fixture(); let finish!: () => void;
    h.writer.encoded.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const persist = h.service.persist(args);
    const otherStore = { prepareWrite: vi.fn(async () => h.writer), read: vi.fn() } as unknown as MotifFrameStore;
    const { bake: _bake, ...preview } = args;
    await expect(h.service.capture(owner, preview, () => true, undefined, otherStore)).resolves.toMatchObject({ kind: 'texture', persisted: false });
    finish(); await persist;
    expect(h.deps.texture).toHaveBeenCalledTimes(2);
    expect(h.read).not.toHaveBeenCalled();
  });

  it.each(['prepare', 'write'] as const)('optional persistence %s failure keeps the captured texture without recapture', async failure => {
    const h = fixture();
    if (failure === 'prepare') h.prepareWrite.mockRejectedValue(new Error('disk unavailable'));
    else h.writer.encoded.mockRejectedValue(new Error('disk full'));
    await expect(h.service.capture(owner, { ...args, bakeOptional: true })).resolves.toMatchObject({ kind: 'texture', persisted: false });
    expect(h.deps.texture).toHaveBeenCalledTimes(1);
    expect(h.deps.copy).toHaveBeenCalledTimes(1);
    expect(h.deps.png).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('optional PNG persistence failure retains the same captured bytes', async () => {
    const h = fixture(false); h.writer.png.mockRejectedValue(new Error('disk full'));
    await expect(h.service.capture(owner, { ...args, bakeOptional: true })).resolves.toMatchObject({ kind: 'png', bytes: Buffer.from('png'), persisted: false });
    expect(h.deps.png).toHaveBeenCalledTimes(1);
  });

  it('optional export pixels remain available after a joined background disk failure', async () => {
    const h = fixture(); let finish!: () => void;
    h.deps.texture.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(texture);
    });
    h.writer.encoded.mockRejectedValue(new Error('disk full'));
    const persist = h.service.persist(args);
    const rejected = expect(persist).rejects.toThrow('disk full');
    const display = h.service.capture(owner, { ...args, bakeOptional: true });
    finish(); await rejected;
    await expect(display).resolves.toMatchObject({ kind: 'texture', persisted: false });
    expect(h.deps.copy).toHaveBeenCalledTimes(1);
    expect(h.deps.png).not.toHaveBeenCalled();
  });

  it('optional persistence never swallows content errors', async () => {
    const h = fixture(); h.deps.texture.mockRejectedValue(new Error('broken content')); h.deps.isContentFailure.mockReturnValue(true);
    await expect(h.service.capture(owner, { ...args, bakeOptional: true })).rejects.toThrow('broken content');
    expect(h.deps.png).not.toHaveBeenCalled();
  });
});
