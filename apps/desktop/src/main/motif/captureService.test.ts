import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeImage, OffscreenSharedTexture, WebContents } from 'electron';
import type { MotifOsrFrame } from './offscreenFrames';
import { MotifCaptureService, type CaptureServiceDeps } from './captureService';
import type { MotifFrameStore } from './frameStore';
import { MotifError } from '../../shared/motifs/errors';

const pressure = vi.hoisted(() => ({ pause: undefined as 'memory' | 'playback' | undefined }));
vi.mock('../resources', async original => ({
  ...await original<typeof import('../resources')>(),
  backgroundResourcePause: () => pressure.pause,
}));

const owner = { id: 12 } as WebContents;
const args = { motifId: 'synthetic', tSec: 0, propsJson: '{}', width: 2, height: 2, contentHash: 'v1', coalesceKey: 'job', high: false, bake: { hash: 'a'.repeat(32), frame: 0 } };
const frame = { kind: 'texture' as const, texture: { textureInfo: { codedSize: { width: 2, height: 3 }, pixelFormat: 'bgra', handle: { ntHandle: Buffer.alloc(8) } } } as OffscreenSharedTexture, width: 2, height: 2 };
/// A bitmap host's paint: premultiplied BGRA, the marker row below the picture.
const bitmapFrame = { kind: 'bitmap' as const, image: { toBitmap: () => Buffer.alloc(2 * 3 * 4, 7) } as unknown as NativeImage, width: 2, height: 2 };
const RGBA = Buffer.from('straight rgba 16');
const BITMAP_WFRM = Buffer.from('wfrm from bitmap');
function fixture(enabled = true) {
  const writer = { encoded: vi.fn(async () => {}) };
  const finish = vi.fn(async () => Buffer.from('wfrm'));
  const encoder = { read: vi.fn(async () => ({ finish, finishPng: vi.fn() })), close: vi.fn() };
  // The host takes textures while the service keeps them enabled.
  let textureHost = false;
  const prepareWrite = vi.fn(async () => writer);
  const has = vi.fn(async (_hash: string, _frame: number): Promise<boolean> => true);
  const hasRoom = vi.fn((_hash: string, _frame: number) => true);
  // No capture path reads stored pixels in main (ADR 0154).
  const read = vi.fn();
  const readTexture = vi.fn();
  const deps = {
    store: { prepareWrite, has, hasRoom, read, readTexture } as unknown as MotifFrameStore,
    frame: vi.fn(async (_args: unknown, consume: (f: MotifOsrFrame) => Promise<any>) => consume(textureHost ? frame : bitmapFrame)),
    copy: vi.fn(async () => ({ kind: 'texture' as const, key: 'pool', token: 'lease' })),
    createEncoder: vi.fn(() => encoder),
    pixels: { motifStraightenBgra: vi.fn(async () => RGBA), motifEncodeRgba: vi.fn(async () => BITMAP_WFRM), motifEncodeBgra: vi.fn(async () => BITMAP_WFRM) },
    setTextureEnabled: vi.fn((on: boolean) => { textureHost = on; }),
    promote: vi.fn(),
    writeSlots: 2,
  } satisfies CaptureServiceDeps;
  return { deps, writer, encoder, finish, prepareWrite, has, hasRoom, read, readTexture, service: new MotifCaptureService(deps, enabled) };
}

afterEach(() => { pressure.pause = undefined; });

describe('Motif capture and persistence', () => {
  it('does not deliver an old document capture to its replacement or disable GPU capture', async () => {
    const h = fixture(); const { bake: _bake, ...preview } = args;
    let current = true;
    let finish!: () => void;
    h.deps.frame.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(frame);
    });
    const result = h.service.capture(owner, preview, () => current);
    current = false;
    finish();
    await expect(result).rejects.toMatchObject({ code: 'superseded' });
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(await h.service.capture(owner, preview)).toMatchObject({ kind: 'texture' });
  });

  it('a bake too late for a display lease captures its own frame', async () => {
    const h = fixture(); const { bake: _bake, ...preview } = args;
    let finish!: () => void;
    h.deps.copy.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { kind: 'texture', key: 'pool', token: 'lease' };
    });
    const display = h.service.capture(owner, preview);
    await vi.waitFor(() => expect(h.deps.copy).toHaveBeenCalled());
    const persist = h.service.persist(args);
    finish();
    expect(await display).toMatchObject({ persisted: false });
    await persist;
    expect(h.encoder.read).toHaveBeenCalledTimes(1);
    expect(h.deps.frame).toHaveBeenCalledTimes(2);
  });

  it('a kept frame leaves the lease with its pixels delivered, and reports once its file is written', async () => {
    const h = fixture(); let finish!: () => void; let leaseEnded = false;
    h.writer.encoded.mockReturnValue(new Promise<void>(r => { finish = r; }));
    h.deps.frame.mockImplementationOnce(async (_args, consume) => {
      const result = await consume(frame);
      leaseEnded = true;
      return result;
    });
    let settled = false;
    const result = h.service.capture(owner, args).finally(() => { settled = true; });
    await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalled());
    expect(leaseEnded).toBe(true);
    expect(h.deps.copy).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    finish();
    expect(await result).toMatchObject({ kind: 'texture', persisted: true });
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled();
    expect(h.deps.frame).toHaveBeenCalledWith(expect.anything(), expect.any(Function), '12:job', false, expect.any(Function));
  });

  it('without a GPU stores the bitmap it delivers, straightened once', async () => {
    const h = fixture(false);
    const result = await h.service.capture(owner, args);
    expect(result).toMatchObject({ kind: 'pixels', width: 2, height: 2, persisted: true });
    expect(Buffer.from((result as { bytes: Uint8Array }).bytes)).toEqual(RGBA);
    expect(h.deps.pixels.motifStraightenBgra).toHaveBeenCalledExactlyOnceWith(expect.any(Buffer), 2, 2);
    expect(h.deps.pixels.motifEncodeRgba).toHaveBeenCalledExactlyOnceWith(RGBA, 2, 2);
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM);
    expect(h.encoder.read).not.toHaveBeenCalled();
  });

  it('a failed readback still shows its texture, and later frames are bitmaps', async () => {
    const h = fixture(); h.encoder.read.mockRejectedValue(new MotifError('device', 'device unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await h.service.capture(owner, args)).toMatchObject({ kind: 'texture', persisted: false });
    expect(h.encoder.read).toHaveBeenCalledWith(frame.texture.textureInfo.handle.ntHandle, 2); // the picture rows only
    expect(h.deps.setTextureEnabled).toHaveBeenLastCalledWith(false);
    expect(h.encoder.close).toHaveBeenCalledTimes(1);
    expect(await h.service.capture(owner, args)).toMatchObject({ kind: 'pixels', persisted: true });
    expect(h.encoder.read).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a disk error costs a kept frame its receipt, not its pixels or a healthy GPU', async () => {
    const h = fixture(); h.writer.encoded.mockRejectedValue(new Error('disk full'));
    await expect(h.service.capture(owner, args)).resolves.toMatchObject({ kind: 'texture', persisted: false });
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled(); expect(h.deps.copy).toHaveBeenCalledOnce();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('GPU capture failure moves the session to bitmaps and captures the frame again', async () => {
    const h = fixture(); h.deps.frame.mockRejectedValueOnce(new Error('OSR unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await h.service.capture(owner, args)).toMatchObject({ kind: 'pixels', persisted: true });
    expect(h.deps.setTextureEnabled).toHaveBeenLastCalledWith(false);
    expect(await h.service.capture(owner, args)).toMatchObject({ kind: 'pixels' });
    expect(h.deps.frame).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('a hung host keeps its error and the shared-texture path: no bitmap switch for the session', async () => {
    const h = fixture();
    const hung = new MotifError('timeout', 'motif capture timed out after 5000ms: Runtime.evaluate');
    h.deps.frame.mockRejectedValueOnce(hung);
    await expect(h.service.capture(owner, args)).rejects.toBe(hung);
    h.deps.frame.mockRejectedValueOnce(hung);
    await expect(h.service.persist(args)).rejects.toBe(hung);
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(await h.service.capture(owner, args)).toMatchObject({ kind: 'texture' });
  });

  it.each(['content', 'transient', 'capacity', 'superseded'] as const)('a %s failure keeps the shared-texture path', async code => {
    const h = fixture();
    const failure = new MotifError(code, 'synthetic');
    h.deps.frame.mockRejectedValueOnce(failure);
    await expect(h.service.capture(owner, args)).rejects.toBe(failure);
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(await h.service.capture(owner, args)).toMatchObject({ kind: 'texture' });
  });

  it.each(['transient', 'oversize', 'closed'] as const)('a %s readback costs a display its receipt, not the GPU path', async code => {
    const h = fixture(); h.encoder.read.mockRejectedValueOnce(new MotifError(code, 'synthetic readback'));
    expect(await h.service.capture(owner, args)).toMatchObject({ kind: 'texture', persisted: false });
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.encoder.close).not.toHaveBeenCalled();
  });

  it.each(['transient', 'oversize', 'closed'] as const)('a %s readback fails that bake frame only; the next reads its texture', async code => {
    const h = fixture();
    const failure = new MotifError(code, 'synthetic readback');
    h.encoder.read.mockRejectedValueOnce(failure);
    await expect(h.service.persist(args)).rejects.toBe(failure);
    expect(h.deps.frame).toHaveBeenCalledOnce();
    await h.service.persist({ ...args, tSec: 1, bake: { ...args.bake, frame: 1 } });
    expect(h.encoder.read).toHaveBeenCalledTimes(2);
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(Buffer.from('wfrm'));
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.encoder.close).not.toHaveBeenCalled();
  });

  it('content errors and superseded requests do not trigger recapture', async () => {
    const h = fixture();
    h.deps.frame.mockRejectedValue(new MotifError('content', 'broken motif'));
    await expect(h.service.capture(owner, args)).rejects.toThrow('broken motif');
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled();
    expect(h.writer.encoded).not.toHaveBeenCalled();
  });

  it('a frame with no cache address writes nothing', async () => {
    const h = fixture(); const { bake: _bake, ...preview } = args;
    expect(await h.service.capture(owner, preview)).toMatchObject({ persisted: false });
    expect(h.prepareWrite).not.toHaveBeenCalled(); expect(h.encoder.read).not.toHaveBeenCalled();
  });

  it('persists without a renderer owner, GPU copy, or pixel delivery', async () => {
    const h = fixture();
    await expect(h.service.persist(args)).resolves.toBeUndefined();
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(Buffer.from('wfrm'));
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled();
  });

  it('persists bitmaps without shared texture support, straightened only by the encode', async () => {
    const h = fixture(false);
    await h.service.persist(args);
    expect(h.deps.pixels.motifEncodeBgra).toHaveBeenCalledExactlyOnceWith(Buffer.alloc(2 * 3 * 4, 7), 2, 2);
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled();
    expect(h.deps.pixels.motifEncodeRgba).not.toHaveBeenCalled();
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM);
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.deps.frame).toHaveBeenCalledOnce();
  });

  it('without a GPU transport the session takes bitmaps', async () => {
    const h = fixture();
    const service = new MotifCaptureService({ ...h.deps, copy: null }, true);
    expect(h.deps.setTextureEnabled).toHaveBeenLastCalledWith(false);
    await service.persist(args);
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM);
    const { bake: _bake, ...preview } = args;
    await expect(service.capture(owner, preview)).resolves.toMatchObject({ kind: 'pixels', persisted: false });
  });

  it('a failed readback persists the same frame as a bitmap, and later frames too', async () => {
    const h = fixture(); h.encoder.read.mockRejectedValue(new MotifError('device', 'device unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await h.service.persist(args);
    await h.service.persist({ ...args, tSec: 1, bake: { ...args.bake, frame: 1 } });
    expect(h.deps.frame).toHaveBeenCalledTimes(3);
    expect(h.encoder.read).toHaveBeenCalledTimes(1);
    expect(h.encoder.close).toHaveBeenCalledTimes(1);
    expect(h.writer.encoded).toHaveBeenCalledTimes(2);
    expect(h.writer.encoded).toHaveBeenCalledWith(BITMAP_WFRM);
    expect(h.deps.setTextureEnabled).toHaveBeenLastCalledWith(false);
    warn.mockRestore();
  });

  it('persistence disk failure stays an error without recapture or disabling GPU', async () => {
    const h = fixture(); h.writer.encoded.mockRejectedValue(new Error('disk full'));
    await expect(h.service.persist(args)).rejects.toThrow('disk full');
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled();
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('already-cancelled persistence performs no capture or disk work', async () => {
    const h = fixture();
    await expect(h.service.persist(args, () => false)).rejects.toMatchObject({ code: 'superseded' });
    expect(h.prepareWrite).not.toHaveBeenCalled();
    expect(h.deps.frame).not.toHaveBeenCalled();
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled();
  });

  it('cancellation during capture performs no encoding or disk work', async () => {
    const h = fixture(); let current = true; let finish!: () => void;
    h.deps.frame.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(frame);
    });
    const result = h.service.persist(args, () => current);
    current = false; finish();
    await expect(result).rejects.toMatchObject({ code: 'superseded' });
    expect(h.prepareWrite).not.toHaveBeenCalled();
    expect(h.encoder.read).not.toHaveBeenCalled();
  });

  it('concurrent persistence and display share a capture, then the display gets the stored marker without a pixel read', async () => {
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
    await expect(display).resolves.toEqual({ kind: 'stored', persisted: true });
    expect(h.deps.frame).toHaveBeenCalledTimes(1);
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.readTexture).not.toHaveBeenCalled();
    expect(h.has).not.toHaveBeenCalled();
  });

  it('a persistence demand joins an existing display before consumption', async () => {
    const h = fixture(); let finish!: () => void;
    h.deps.frame.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(frame);
    });
    const { bake: _bake, ...preview } = args;
    const display = h.service.capture(owner, preview);
    const persist = h.service.persist(args);
    finish();
    await expect(display).resolves.toMatchObject({ persisted: true });
    await expect(persist).resolves.toBeUndefined();
    expect(h.deps.frame).toHaveBeenCalledTimes(1);
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
    expect(display).toEqual({ kind: 'stored', persisted: true });
    expect(h.has).toHaveBeenCalledExactlyOnceWith(bake.hash, bake.frame);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.readTexture).not.toHaveBeenCalled();
    expect(h.deps.frame).toHaveBeenCalledTimes(1);
    expect(h.writer.encoded).toHaveBeenCalledTimes(1);
  });

  it('captures live when the cache recheck finds no frame or cannot stat it', async () => {
    const h = fixture(false);
    h.has.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('EACCES'));
    const { bake: _bake, ...preview } = args;
    for (let i = 0; i < 2; i++) {
      await expect(h.service.capture(owner, { ...preview, cache: args.bake })).resolves.toMatchObject({ kind: 'pixels', persisted: false });
    }
    expect(h.has).toHaveBeenCalledTimes(2);
    expect(h.deps.frame).toHaveBeenCalledTimes(2);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('shares a display cache recheck with persistence that arrives during the check', async () => {
    const h = fixture(false);
    let finish!: (value: boolean) => void;
    h.has.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { bake, ...preview } = args;
    const display = h.service.capture(owner, { ...preview, cache: bake });
    const persist = h.service.persist(args);
    await Promise.resolve();
    expect(h.deps.frame).not.toHaveBeenCalled();
    finish(false);
    await expect(display).resolves.toMatchObject({ persisted: true });
    await persist;
    expect(h.deps.frame).toHaveBeenCalledTimes(1);
    expect(h.writer.encoded).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge another cache address as persisted when a bake joins a cache hit', async () => {
    const h = fixture(false);
    let finish!: (value: boolean) => void;
    h.has.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { bake, ...preview } = args;
    const display = h.service.capture(owner, { ...preview, cache: bake });
    const other = { hash: 'b'.repeat(32), frame: 0 };
    const persist = h.service.persist({ ...args, bake: other });
    finish(true);
    await Promise.all([display, persist]);
    expect(h.prepareWrite).toHaveBeenCalledExactlyOnceWith(other.hash, other.frame);
    expect(h.writer.encoded).toHaveBeenCalledTimes(1);
  });

  it('cancelling background interest preserves a joined current display consumer', async () => {
    const h = fixture(); let finish!: () => void; let backgroundCurrent = true;
    h.deps.frame.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(frame);
    });
    const persist = h.service.persist(args, () => backgroundCurrent);
    const rejected = expect(persist).rejects.toMatchObject({ code: 'superseded' });
    const { bake: _bake, ...preview } = args;
    const display = h.service.capture(owner, preview);
    backgroundCurrent = false; finish();
    await rejected;
    await expect(display).resolves.toEqual({ kind: 'stored', persisted: true });
    expect(h.deps.frame).toHaveBeenCalledTimes(1);
    expect(h.writer.encoded).toHaveBeenCalledTimes(1);
  });

  it('a foreground display promotes the queued shared background capture', async () => {
    const h = fixture(); let finish!: () => void;
    h.deps.frame.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(frame);
    });
    const persist = h.service.persist(args);
    const { bake: _bake, ...preview } = args;
    const display = h.service.capture(owner, { ...preview, high: true });
    expect(h.deps.promote).toHaveBeenCalledExactlyOnceWith('job');
    finish(); await persist; await display;
    expect(h.deps.frame).toHaveBeenCalledTimes(1);
  });

  it('workspace sessions do not share pending persistence acknowledgements', async () => {
    const h = fixture(); let finish!: () => void;
    h.writer.encoded.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const persist = h.service.persist(args);
    const otherStore = { prepareWrite: vi.fn(async () => h.writer), has: vi.fn() } as unknown as MotifFrameStore;
    const { bake: _bake, ...preview } = args;
    await expect(h.service.capture(owner, preview, () => true, undefined, otherStore)).resolves.toMatchObject({ kind: 'texture', persisted: false });
    finish(); await persist;
    expect(h.deps.frame).toHaveBeenCalledTimes(2);
    expect(h.has).not.toHaveBeenCalled();
  });

  it.each(['prepare', 'write'] as const)('a %s failure keeps the captured texture without recapture', async failure => {
    const h = fixture();
    if (failure === 'prepare') h.prepareWrite.mockRejectedValue(new Error('disk unavailable'));
    else h.writer.encoded.mockRejectedValue(new Error('disk full'));
    await expect(h.service.capture(owner, args)).resolves.toMatchObject({ kind: 'texture', persisted: false });
    expect(h.deps.frame).toHaveBeenCalledTimes(1);
    expect(h.deps.copy).toHaveBeenCalledTimes(1);
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('a bitmap write failure retains the same delivered pixels', async () => {
    const h = fixture(false); h.writer.encoded.mockRejectedValue(new Error('disk full'));
    await expect(h.service.capture(owner, args)).resolves.toMatchObject({ kind: 'pixels', width: 2, height: 2, persisted: false });
    expect(h.deps.frame).toHaveBeenCalledTimes(1);
  });

  it('a display joined to a background write still gets pixels when that write fails', async () => {
    const h = fixture(); let finish!: () => void;
    h.deps.frame.mockImplementationOnce(async (_args, consume) => {
      await new Promise<void>(resolve => { finish = resolve; });
      return consume(frame);
    });
    h.writer.encoded.mockRejectedValue(new Error('disk full'));
    const persist = h.service.persist(args);
    const rejected = expect(persist).rejects.toThrow('disk full');
    const display = h.service.capture(owner, args);
    finish(); await rejected;
    await expect(display).resolves.toMatchObject({ kind: 'texture', persisted: false });
    expect(h.deps.copy).toHaveBeenCalledTimes(1);
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled();
  });

  it('a kept frame never swallows content errors', async () => {
    const h = fixture(); h.deps.frame.mockRejectedValue(new MotifError('content', 'broken content'));
    await expect(h.service.capture(owner, args)).rejects.toThrow('broken content');
    expect(h.deps.pixels.motifStraightenBgra).not.toHaveBeenCalled();
  });

  describe('a live capture stores itself', () => {
    const { bake, ...preview } = args;
    const at = (frame: number) => ({ ...preview, tSec: frame, cache: { hash: bake.hash, frame } });
    const missing = (h: ReturnType<typeof fixture>) => h.has.mockResolvedValue(false);

    it('at its cache address, without holding the lease or the display for the write', async () => {
      const h = fixture(); missing(h); let finish!: (bytes: Buffer<ArrayBuffer>) => void;
      h.finish.mockReturnValueOnce(new Promise(r => { finish = r; }));
      await expect(h.service.capture(owner, at(3))).resolves.toMatchObject({ kind: 'texture', persisted: false });
      expect(h.deps.copy).toHaveBeenCalledOnce();
      expect(h.prepareWrite).toHaveBeenCalledExactlyOnceWith(bake.hash, 3);
      expect(h.writer.encoded).not.toHaveBeenCalled();
      finish(Buffer.from('wfrm'));
      await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(Buffer.from('wfrm')));
    });

    it('never while two frames are in flight; the third is still delivered', async () => {
      const h = fixture(); missing(h);
      h.finish.mockReturnValue(new Promise(() => {}));
      for (const frame of [0, 1, 2]) await expect(h.service.capture(owner, at(frame))).resolves.toMatchObject({ kind: 'texture' });
      expect(h.encoder.read).toHaveBeenCalledTimes(2);
      expect(h.deps.copy).toHaveBeenCalledTimes(3);
    });

    it('never under memory pressure, though playback alone does not stop it', async () => {
      const h = fixture(); missing(h);
      pressure.pause = 'memory';
      await h.service.capture(owner, at(0));
      expect(h.encoder.read).not.toHaveBeenCalled();
      pressure.pause = 'playback';
      await h.service.capture(owner, at(1));
      expect(h.encoder.read).toHaveBeenCalledOnce();
    });

    it('never when the cache has no room, without reading back', async () => {
      const h = fixture(); missing(h); h.hasRoom.mockReturnValue(false);
      await expect(h.service.capture(owner, at(0))).resolves.toMatchObject({ kind: 'texture' });
      expect(h.encoder.read).not.toHaveBeenCalled();
    });

    describe('on a bitmap host', () => {
      it('from the pixels it delivers, without holding the display for the write', async () => {
        const h = fixture(false); missing(h); let finish!: () => void;
        h.writer.encoded.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
        await expect(h.service.capture(owner, at(3))).resolves.toMatchObject({ kind: 'pixels', width: 2, height: 2, persisted: false });
        expect(h.prepareWrite).toHaveBeenCalledExactlyOnceWith(bake.hash, 3);
        await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM));
        expect(h.deps.pixels.motifStraightenBgra).toHaveBeenCalledOnce();
        finish();
      });

      it('never while two frames are in flight; the third is still delivered', async () => {
        const h = fixture(false); missing(h);
        h.writer.encoded.mockReturnValue(new Promise<void>(() => {}));
        for (const frame of [0, 1, 2]) await expect(h.service.capture(owner, at(frame))).resolves.toMatchObject({ kind: 'pixels' });
        await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledTimes(2));
      });

      it('never under memory pressure or without room', async () => {
        const h = fixture(false); missing(h);
        pressure.pause = 'memory';
        await h.service.capture(owner, at(0));
        pressure.pause = undefined; h.hasRoom.mockReturnValue(false);
        await h.service.capture(owner, at(1));
        expect(h.prepareWrite).not.toHaveBeenCalled();
      });

      it('and a failed write does not reach the display', async () => {
        const h = fixture(false); missing(h);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        h.writer.encoded.mockRejectedValue(new Error('disk full'));
        await expect(h.service.capture(owner, at(0))).resolves.toMatchObject({ kind: 'pixels', persisted: false });
        await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
        warn.mockRestore();
      });

      it('and a parameter preview, which has no cache address, stores nothing', async () => {
        const h = fixture(false);
        await expect(h.service.capture(owner, preview)).resolves.toMatchObject({ kind: 'pixels', persisted: false });
        expect(h.prepareWrite).not.toHaveBeenCalled();
      });
    });

    it('after a session switch to bitmaps too', async () => {
      const h = fixture(); missing(h);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.deps.frame.mockRejectedValueOnce(new Error('OSR unavailable'));
      await expect(h.service.capture(owner, at(0))).resolves.toMatchObject({ kind: 'pixels', persisted: false });
      await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM));
      warn.mockRestore();
    });

    it('and a failed write reaches neither the display nor the GPU path', async () => {
      const h = fixture(); missing(h);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.writer.encoded.mockRejectedValue(new Error('disk full'));
      for (const frame of [0, 1]) {
        await expect(h.service.capture(owner, at(frame))).resolves.toMatchObject({ kind: 'texture' });
        await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledTimes(frame + 1));
      }
      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
      expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
      warn.mockRestore();
    });

    it('and a failed readback delivers this frame and takes bitmaps after it', async () => {
      const h = fixture(); missing(h);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.encoder.read.mockRejectedValue(new MotifError('device', 'device unavailable'));
      await expect(h.service.capture(owner, at(0))).resolves.toMatchObject({ kind: 'texture' });
      await expect(h.service.capture(owner, at(1))).resolves.toMatchObject({ kind: 'pixels' });
      expect(h.encoder.read).toHaveBeenCalledOnce();
      expect(h.deps.copy).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    it('and a baker waits for that write instead of capturing the frame again', async () => {
      const h = fixture(); missing(h); let finish!: (bytes: Buffer<ArrayBuffer>) => void;
      h.finish.mockReturnValueOnce(new Promise(r => { finish = r; }));
      await h.service.capture(owner, at(0));
      const persist = h.service.persist({ ...args, tSec: 0 });
      finish(Buffer.from('wfrm'));
      await persist;
      expect(h.deps.frame).toHaveBeenCalledOnce();
      expect(h.writer.encoded).toHaveBeenCalledOnce();
    });

    it('and the next request for that frame reads the file it is writing', async () => {
      const h = fixture(); missing(h); let finish!: (bytes: Buffer<ArrayBuffer>) => void;
      h.finish.mockReturnValueOnce(new Promise(r => { finish = r; }));
      await h.service.capture(owner, at(0));
      h.has.mockResolvedValue(true);
      const again = h.service.capture(owner, at(0));
      finish(Buffer.from('wfrm'));
      await expect(again).resolves.toEqual({ kind: 'stored', persisted: true });
      expect(h.deps.frame).toHaveBeenCalledOnce();
    });
  });
});
