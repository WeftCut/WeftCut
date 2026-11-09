import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeImage, OffscreenSharedTexture, WebContents } from 'electron';
import type { MotifOsrFrame } from './offscreenFrames';
import type { CaptureOptions, CaptureRun } from './captureQueue';
import { MotifCaptureService, parseMotifCaptureControl, parseMotifCaptureRequest, parseMotifPresence, type CaptureServiceDeps } from './captureService';
import type { MotifFrameStore } from './frameStore';
import type { MotifCaptureRequest } from '../../shared/motifs/frameTransport';
import { MotifError } from '../../shared/motifs/errors';
import { loadMotifNative, type MotifConversion } from './native';
import { MOTIF_LIMITS } from '../../shared/motifs/limits';

const pressure = vi.hoisted(() => ({ pause: undefined as 'memory' | 'playback' | undefined, refuse: false }));
vi.mock('../resources', async original => ({
  ...await original<typeof import('../resources')>(),
  backgroundResourcePause: () => pressure.pause,
  reserveResources: () => {
    if (pressure.refuse) throw new Error('resource-capacity-exceeded: synthetic');
    return () => {};
  },
  // `refuse` stands for host-critical memory here, which the floor refuses too.
  reserveFloorResources: () => {
    if (pressure.refuse) throw new Error('resource-capacity-exceeded: synthetic');
    return () => {};
  },
}));

const owner = { id: 12 } as WebContents;
const bake = { hash: 'a'.repeat(32), frame: 0 };
const args = { motifId: 'synthetic', tSec: 0, propsJson: '{}', width: 2, height: 2, contentHash: 'v1' };
let nextRequestId = 0;
/** A preview request with no cache address unless given one. */
const preview = (over: Partial<MotifCaptureRequest> = {}): MotifCaptureRequest => ({ ...args, requestId: ++nextRequestId, priority: 'current', ...over });
/** An export frame: kept at its address. */
const kept = (over: Partial<MotifCaptureRequest> = {}) => preview({ address: bake, store: 'keep', ...over });
const background = { priority: 'background' as const, isCurrent: () => true };
const frame = { kind: 'texture' as const, texture: { textureInfo: { codedSize: { width: 2, height: 3 }, pixelFormat: 'bgra', handle: { ntHandle: Buffer.alloc(8) } } } as OffscreenSharedTexture, width: 2, height: 2 };
/// A bitmap host's paint: premultiplied BGRA, the marker row below the picture.
const bitmapFrame = { kind: 'bitmap' as const, image: { toBitmap: () => Buffer.alloc(2 * 3 * 4, 7) } as unknown as NativeImage, width: 2, height: 2 };
const RGBA = Buffer.from('straight rgba 16');
type PixelArgs = [pixels: Buffer, width: number, height: number];
const BITMAP_WFRM = Buffer.from('wfrm from bitmap');
const run = (result: Promise<any>): CaptureRun<any> => ({ result, ticket: { setPriority: vi.fn(), cancel: vi.fn() } });
/** `texture`: what a texture host paints. */
function fixture(enabled = true, texture: typeof frame = frame, over: Partial<CaptureServiceDeps> = {}) {
  const writer = { encoded: vi.fn(async () => {}) };
  const finish = vi.fn(async (_to: 'frame' | 'png') => Buffer.from('wfrm'));
  const encoder = { read: vi.fn(async () => ({ finish })), close: vi.fn() };
  /** The native conversions `convert` dispatches to. */
  const pixels = { straighten: vi.fn(async (..._: PixelArgs) => RGBA), encodeRgba: vi.fn(async (..._: PixelArgs) => BITMAP_WFRM), encodeBgra: vi.fn(async (..._: PixelArgs) => BITMAP_WFRM) };
  // The host takes textures while the service keeps them enabled.
  let textureHost = false;
  const prepareWrite = vi.fn(async () => writer);
  const has = vi.fn(async (_hash: string, _frame: number): Promise<boolean> => false);
  const hasRoom = vi.fn((_hash: string, _frame: number) => true);
  // No capture path reads stored pixels in main (ADR 0154).
  const read = vi.fn();
  const readTexture = vi.fn();
  const paint = () => textureHost ? texture : bitmapFrame;
  // A capture loop fails the test instead of hanging it.
  let captures = 0;
  const deps = {
    store: { prepareWrite, has, hasRoom, read, readTexture } as unknown as MotifFrameStore,
    frame: vi.fn((_args: unknown, consume: (f: MotifOsrFrame) => Promise<any>, _options: CaptureOptions) => ++captures > 6
      ? run(Promise.reject(new MotifError('content', 'capture loop')))
      : run(Promise.resolve().then(() => consume(paint())))),
    copy: vi.fn(async () => ({ kind: 'texture' as const, key: 'pool', token: 'lease' })),
    openTextureReader: vi.fn(() => encoder),
    convert: (conversion: MotifConversion, px: Buffer, width: number, height: number) => conversion.from === 'rgba'
      ? pixels.encodeRgba(px, width, height)
      : conversion.to === 'rgba' ? pixels.straighten(px, width, height) : pixels.encodeBgra(px, width, height),
    setTextureEnabled: vi.fn((on: boolean) => { textureHost = on; }),
    writeSlots: 2,
  } satisfies CaptureServiceDeps;
  /** The next capture fails before its lease. */
  const failNext = (error: unknown) => deps.frame.mockImplementationOnce(() => run(Promise.reject(error)));
  /** The next capture waits for the returned release before its lease. */
  const holdNext = () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    deps.frame.mockImplementationOnce((_args, consume) => run(gate.then(() => consume(paint()))));
    return () => release();
  };
  return { deps, pixels, writer, encoder, finish, prepareWrite, has, hasRoom, read, readTexture, failNext, holdNext, service: new MotifCaptureService({ ...deps, ...over }, enabled) };
}

afterEach(() => { pressure.pause = undefined; pressure.refuse = false; });

describe('Motif capture and persistence', () => {
  it('does not deliver an old document capture to its replacement or disable GPU capture', async () => {
    const h = fixture(); let current = true;
    const release = h.holdNext();
    const result = h.service.capture(owner, preview(), () => current);
    current = false;
    release();
    await expect(result).resolves.toEqual({ kind: 'superseded' });
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.pixels.straighten).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(await h.service.capture(owner, preview())).toMatchObject({ kind: 'texture' });
  });

  it('a kept frame leaves the lease with its pixels delivered, and reports once its file is written', async () => {
    const h = fixture(); let finish!: () => void; let leaseEnded = false;
    h.writer.encoded.mockReturnValue(new Promise<void>(r => { finish = r; }));
    h.deps.frame.mockImplementationOnce((_args, consume) => run(consume(frame).then(result => { leaseEnded = true; return result; })));
    let settled = false;
    const result = h.service.capture(owner, kept()).finally(() => { settled = true; });
    await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalled());
    expect(leaseEnded).toBe(true);
    expect(h.deps.copy).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    finish();
    expect(await result).toMatchObject({ kind: 'texture', persisted: true });
    expect(h.pixels.straighten).not.toHaveBeenCalled();
    expect(h.deps.frame).toHaveBeenCalledWith(expect.anything(), expect.any(Function), expect.objectContaining({ priority: 'current' }));
    expect(h.has).toHaveBeenCalledOnce();
  });

  it('without a GPU stores the bitmap it delivers, straightened once', async () => {
    const h = fixture(false);
    const result = await h.service.capture(owner, kept());
    expect(result).toMatchObject({ kind: 'pixels', width: 2, height: 2, persisted: true });
    expect(Buffer.from((result as { bytes: Uint8Array }).bytes)).toEqual(RGBA);
    expect(h.pixels.straighten).toHaveBeenCalledExactlyOnceWith(expect.any(Buffer), 2, 2);
    expect(h.pixels.encodeRgba).toHaveBeenCalledExactlyOnceWith(RGBA, 2, 2);
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM);
    expect(h.encoder.read).not.toHaveBeenCalled();
  });

  it('a failed readback still shows its texture, and later frames are bitmaps', async () => {
    const h = fixture(); h.encoder.read.mockRejectedValue(new MotifError('device', 'device unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await h.service.capture(owner, kept())).toMatchObject({ kind: 'texture', persisted: false });
    expect(h.encoder.read).toHaveBeenCalledWith(frame.texture.textureInfo.handle.ntHandle, 2); // the picture rows only
    expect(h.deps.setTextureEnabled).toHaveBeenLastCalledWith(false);
    expect(h.encoder.close).toHaveBeenCalledTimes(1);
    expect(await h.service.capture(owner, kept())).toMatchObject({ kind: 'pixels', persisted: true });
    expect(h.encoder.read).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a disk error costs a kept frame its receipt, not its pixels or a healthy GPU', async () => {
    const h = fixture(); h.writer.encoded.mockRejectedValue(new Error('disk full'));
    await expect(h.service.capture(owner, kept())).resolves.toMatchObject({ kind: 'texture', persisted: false });
    expect(h.pixels.straighten).not.toHaveBeenCalled(); expect(h.deps.copy).toHaveBeenCalledOnce();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('GPU capture failure moves the session to bitmaps and captures the frame again', async () => {
    const h = fixture(); h.failNext(new Error('OSR unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await h.service.capture(owner, kept())).toMatchObject({ kind: 'pixels', persisted: true });
    expect(h.deps.setTextureEnabled).toHaveBeenLastCalledWith(false);
    expect(await h.service.capture(owner, kept({ afterMiss: true }))).toMatchObject({ kind: 'pixels' });
    expect(h.deps.frame).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('a hung host keeps its error and the shared-texture path: no bitmap switch for the session', async () => {
    const h = fixture();
    const hung = new MotifError('timeout', 'motif capture timed out after 5000ms: Runtime.evaluate');
    h.failNext(hung);
    await expect(h.service.capture(owner, kept())).rejects.toBe(hung);
    h.failNext(hung);
    await expect(h.service.persist(bake, args, background)).rejects.toBe(hung);
    expect(h.pixels.straighten).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(await h.service.capture(owner, kept())).toMatchObject({ kind: 'texture' });
  });

  it.each(['content', 'transient', 'capacity', 'superseded'] as const)('a %s failure keeps the shared-texture path', async code => {
    const h = fixture();
    const failure = new MotifError(code, 'synthetic');
    h.failNext(failure);
    const result = h.service.capture(owner, kept());
    if (code === 'superseded') await expect(result).resolves.toEqual({ kind: 'superseded' });
    else if (code === 'capacity') await expect(result).resolves.toEqual({ kind: 'capacity', detail: 'synthetic' });
    else await expect(result).rejects.toBe(failure);
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(await h.service.capture(owner, kept())).toMatchObject({ kind: 'texture' });
  });

  it('answers a withdrawn request `superseded` instead of throwing it; other failures still throw', async () => {
    const h = fixture();
    h.failNext(new MotifError('superseded', 'synthetic'));
    await expect(h.service.capture(owner, preview())).resolves.toEqual({ kind: 'superseded' });
    const content = new MotifError('content', 'synthetic');
    h.failNext(content);
    await expect(h.service.capture(owner, preview())).rejects.toBe(content);
    h.failNext(new MotifError('closed', 'synthetic'));
    await expect(h.service.capture(owner, preview())).rejects.toMatchObject({ code: 'closed' });
  });

  it('answers a capture refused at dispatch `capacity` with the refusal, instead of throwing it', async () => {
    const h = fixture();
    h.deps.frame.mockImplementationOnce((_args, consume, options) => run(Promise.resolve().then(() => {
      options.dispatch?.();
      return consume(bitmapFrame);
    })));
    pressure.refuse = true;
    await expect(h.service.capture(owner, preview({ address: bake }))).resolves.toEqual({ kind: 'capacity', detail: 'resource-capacity-exceeded: synthetic' });
  });

  it.each(['transient', 'oversize', 'closed'] as const)('a %s readback costs a display its receipt, not the GPU path', async code => {
    const h = fixture(); h.encoder.read.mockRejectedValueOnce(new MotifError(code, 'synthetic readback'));
    expect(await h.service.capture(owner, kept())).toMatchObject({ kind: 'texture', persisted: false });
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.encoder.close).not.toHaveBeenCalled();
  });

  it.each(['transient', 'oversize', 'closed'] as const)('a %s readback fails that bake frame only; the next reads its texture', async code => {
    const h = fixture();
    const failure = new MotifError(code, 'synthetic readback');
    h.encoder.read.mockRejectedValueOnce(failure);
    await expect(h.service.persist(bake, args, background)).rejects.toBe(failure);
    expect(h.deps.frame).toHaveBeenCalledOnce();
    await h.service.persist({ ...bake, frame: 1 }, { ...args, tSec: 1 }, background);
    expect(h.encoder.read).toHaveBeenCalledTimes(2);
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(Buffer.from('wfrm'));
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.encoder.close).not.toHaveBeenCalled();
  });

  it('a frame with no cache address writes nothing', async () => {
    const h = fixture();
    expect(await h.service.capture(owner, preview({ store: 'keep' }))).toMatchObject({ persisted: false });
    expect(h.prepareWrite).not.toHaveBeenCalled(); expect(h.encoder.read).not.toHaveBeenCalled();
    expect(h.has).not.toHaveBeenCalled();
  });

  it('persists without a renderer owner, GPU copy, or pixel delivery', async () => {
    const h = fixture();
    await expect(h.service.persist(bake, args, background)).resolves.toBeUndefined();
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(Buffer.from('wfrm'));
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.pixels.straighten).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledExactlyOnceWith('frame');
    expect(h.deps.frame).toHaveBeenCalledWith(expect.anything(), expect.any(Function), expect.objectContaining({ priority: 'background' }));
  });

  it('persists bitmaps without shared texture support, straightened only by the encode', async () => {
    const h = fixture(false);
    await h.service.persist(bake, args, background);
    expect(h.pixels.encodeBgra).toHaveBeenCalledExactlyOnceWith(Buffer.alloc(2 * 3 * 4, 7), 2, 2);
    expect(h.pixels.straighten).not.toHaveBeenCalled();
    expect(h.pixels.encodeRgba).not.toHaveBeenCalled();
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM);
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.deps.frame).toHaveBeenCalledOnce();
  });

  it('without a GPU transport the session takes bitmaps', async () => {
    const h = fixture();
    const service = new MotifCaptureService({ ...h.deps, copy: null }, true);
    expect(h.deps.setTextureEnabled).toHaveBeenLastCalledWith(false);
    await service.persist(bake, args, background);
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM);
    await expect(service.capture(owner, preview())).resolves.toMatchObject({ kind: 'pixels', persisted: false });
  });

  it('a failed readback persists the same frame as a bitmap, and later frames too', async () => {
    const h = fixture(); h.encoder.read.mockRejectedValue(new MotifError('device', 'device unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await h.service.persist(bake, args, background);
    await h.service.persist({ ...bake, frame: 1 }, { ...args, tSec: 1 }, background);
    expect(h.deps.frame).toHaveBeenCalledTimes(3);
    expect(h.encoder.read).toHaveBeenCalledTimes(1);
    expect(h.encoder.close).toHaveBeenCalledTimes(1);
    expect(h.writer.encoded).toHaveBeenCalledTimes(2);
    expect(h.writer.encoded).toHaveBeenCalledWith(BITMAP_WFRM);
    expect(h.deps.setTextureEnabled).toHaveBeenLastCalledWith(false);
    warn.mockRestore();
  });

  it.each([
    ['an unsupported texture format', () => fixture(true, { ...frame, texture: { textureInfo: { ...frame.texture.textureInfo, pixelFormat: 'rgbaf16' } } as OffscreenSharedTexture })],
    ['an encoder that cannot open', () => {
      const h = fixture();
      h.deps.openTextureReader.mockImplementation(() => { throw new Error('no D3D11 device'); });
      return h;
    }],
  ])('%s persists the frame after exactly one bitmap recapture', async (_name, setup) => {
    const h = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(h.service.persist(bake, args, background)).resolves.toBeUndefined();
    expect(h.deps.frame).toHaveBeenCalledTimes(2);
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM);
    expect(h.encoder.read).not.toHaveBeenCalled();
    expect(h.deps.setTextureEnabled).toHaveBeenLastCalledWith(false);
    warn.mockRestore();
  });

  it('a GPU copy failure opens no encoder for the texture it leased: the frame is kept as a bitmap', async () => {
    const h = fixture(); h.deps.copy.mockRejectedValueOnce(new MotifError('device', 'copy lost'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(h.service.capture(owner, kept())).resolves.toMatchObject({ kind: 'pixels', persisted: true });
    expect(h.deps.openTextureReader).not.toHaveBeenCalled();
    expect(h.deps.frame).toHaveBeenCalledTimes(2);
    expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM);
    warn.mockRestore();
  });

  it('persistence disk failure stays an error without recapture or disabling GPU', async () => {
    const h = fixture(); h.writer.encoded.mockRejectedValue(new Error('disk full'));
    await expect(h.service.persist(bake, args, background)).rejects.toThrow('disk full');
    expect(h.pixels.straighten).not.toHaveBeenCalled();
    expect(h.deps.copy).not.toHaveBeenCalled();
    expect(h.deps.frame).toHaveBeenCalledOnce();
    expect(h.deps.setTextureEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  describe('a bitmap\'s native conversion failure keeps its code', () => {
    const tagged = (code: string) => vi.fn(async (..._: PixelArgs): Promise<Buffer> => { throw new Error(`[motif:${code}] synthetic`); });
    /** The addon's conversions through the native adapter. */
    type Conversion = (pixels: Buffer, width: number, height: number) => Promise<Buffer>;
    const nativeConvert = (conversions: { straighten?: Conversion; encodeRgba?: Conversion; encodeBgra?: Conversion }) => {
      const { straighten = async () => RGBA, encodeRgba = tagged('content'), encodeBgra = tagged('content') } = conversions;
      return loadMotifNative({ scratchIdleBytes: 0, bandThreads: 1 }, {
        motifLimits: () => ({ ...MOTIF_LIMITS }), motifConfigure: () => {}, MotifFrameFileReader: class {},
        motifConvert: (px: Buffer, width: number, height: number, from: string, to: string) =>
          (from === 'rgba' ? encodeRgba : to === 'rgba' ? straighten : encodeBgra)(px, width, height),
      }, 'linux').convert;
    };

    it('in the straighten a display waits on', async () => {
      const h = fixture(false, frame, { convert: nativeConvert({ straighten: tagged('oversize') }) });
      await expect(h.service.capture(owner, kept())).rejects.toMatchObject({ code: 'oversize' });
    });

    it('in the encode of the picture a display offers: a refusal is not warned about', async () => {
      const encode = tagged('capacity');
      const h = fixture(false, frame, { convert: nativeConvert({ encodeRgba: encode }) });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(h.service.capture(owner, preview({ address: bake }))).resolves.toMatchObject({ kind: 'pixels', persisted: false });
      await vi.waitFor(() => expect(encode).toHaveBeenCalledExactlyOnceWith(RGBA, 2, 2));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('in the encode of a paint', async () => {
      const h = fixture(false, frame, { convert: nativeConvert({ encodeBgra: tagged('disk') }) });
      await expect(h.service.persist(bake, args, background)).rejects.toMatchObject({ code: 'disk' });
    });
  });

  it('already-cancelled persistence performs no capture or disk work', async () => {
    const h = fixture();
    await expect(h.service.persist(bake, args, { priority: 'background', isCurrent: () => false })).rejects.toMatchObject({ code: 'superseded' });
    expect(h.prepareWrite).not.toHaveBeenCalled();
    expect(h.deps.frame).not.toHaveBeenCalled();
    expect(h.pixels.straighten).not.toHaveBeenCalled();
  });

  it('cancellation during capture performs no readback or encoding', async () => {
    const h = fixture(); let current = true;
    const release = h.holdNext();
    const result = h.service.persist(bake, args, { priority: 'background', isCurrent: () => current });
    current = false; release();
    await expect(result).rejects.toMatchObject({ code: 'superseded' });
    expect(h.encoder.read).not.toHaveBeenCalled();
    expect(h.writer.encoded).not.toHaveBeenCalled();
  });

  it('a kept frame never swallows content errors', async () => {
    const h = fixture(); h.failNext(new MotifError('content', 'broken content'));
    await expect(h.service.capture(owner, kept())).rejects.toThrow('broken content');
    expect(h.pixels.straighten).not.toHaveBeenCalled();
    expect(h.writer.encoded).not.toHaveBeenCalled();
  });

  it('workspace stores never share a job', async () => {
    const h = fixture(); let finish!: () => void;
    h.writer.encoded.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
    const persist = h.service.persist(bake, args, background);
    await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledOnce());
    const otherStore = { prepareWrite: vi.fn(async () => h.writer), has: vi.fn(async () => false), hasRoom: () => false } as unknown as MotifFrameStore;
    await expect(h.service.capture(owner, preview({ address: bake }), () => true, undefined, otherStore)).resolves.toMatchObject({ kind: 'texture', persisted: false });
    finish(); await persist;
    expect(h.deps.frame).toHaveBeenCalledTimes(2);
    expect(h.has).not.toHaveBeenCalled();
  });

  describe('a request in flight', () => {
    it('takes its priority changes and its cancel by sender and request id', async () => {
      const h = fixture();
      const ticket = { setPriority: vi.fn(), cancel: vi.fn() };
      h.deps.frame.mockImplementationOnce(() => ({ result: new Promise(() => {}), ticket }));
      const request = preview({ priority: 'ahead' });
      const result = h.service.capture(owner, request);
      h.service.control(owner.id, { requestId: request.requestId, action: 'priority', priority: 'current' });
      h.service.control(13, { requestId: request.requestId, action: 'cancel' });
      h.service.control(owner.id, { requestId: request.requestId + 1, action: 'cancel' });
      expect(ticket.setPriority).toHaveBeenCalledExactlyOnceWith('current');
      expect(ticket.cancel).not.toHaveBeenCalled();
      h.service.control(owner.id, { requestId: request.requestId, action: 'cancel' });
      await expect(result).resolves.toEqual({ kind: 'superseded' });
      expect(ticket.cancel).toHaveBeenCalledOnce();
    });

    it('a request from a reloaded document takes over the id; the old one settling leaves it', async () => {
      const h = fixture();
      const release = h.holdNext();
      const ticket = { setPriority: vi.fn(), cancel: vi.fn() };
      const old = h.service.capture(owner, preview({ requestId: 1 }));
      h.deps.frame.mockImplementationOnce(() => ({ result: new Promise(() => {}), ticket }));
      const next = h.service.capture(owner, preview({ requestId: 1, tSec: 1 }));
      release(); await old;
      h.service.control(owner.id, { requestId: 1, action: 'cancel' });
      await expect(next).resolves.toEqual({ kind: 'superseded' });
      expect(ticket.cancel).toHaveBeenCalledOnce();
    });

    it('a settled request takes no control', async () => {
      const h = fixture();
      const request = preview();
      await h.service.capture(owner, request);
      expect(() => h.service.control(owner.id, { requestId: request.requestId, action: 'cancel' })).not.toThrow();
    });
  });

  describe('a live capture stores itself', () => {
    const at = (frame: number, over: Partial<MotifCaptureRequest> = {}) => preview({ tSec: frame, address: { hash: bake.hash, frame }, ...over });

    it('at its cache address, without holding the lease or the display for the write', async () => {
      const h = fixture(); let finish!: (bytes: Buffer<ArrayBuffer>) => void;
      h.finish.mockReturnValueOnce(new Promise(r => { finish = r; }));
      await expect(h.service.capture(owner, at(3))).resolves.toMatchObject({ kind: 'texture', persisted: false });
      expect(h.deps.copy).toHaveBeenCalledOnce();
      expect(h.prepareWrite).toHaveBeenCalledExactlyOnceWith(bake.hash, 3);
      expect(h.writer.encoded).not.toHaveBeenCalled();
      finish(Buffer.from('wfrm'));
      await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(Buffer.from('wfrm')));
    });

    it('after a read miss too, without checking the store', async () => {
      const h = fixture(); h.has.mockResolvedValue(true);
      await expect(h.service.capture(owner, at(3, { afterMiss: true }))).resolves.toMatchObject({ kind: 'texture', persisted: false });
      await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledOnce());
      expect(h.has).not.toHaveBeenCalled();
    });

    it('never while two frames are in flight; the third is still delivered', async () => {
      const h = fixture();
      h.finish.mockReturnValue(new Promise(() => {}));
      for (const frame of [0, 1, 2]) await expect(h.service.capture(owner, at(frame))).resolves.toMatchObject({ kind: 'texture' });
      expect(h.encoder.read).toHaveBeenCalledTimes(2);
      expect(h.deps.copy).toHaveBeenCalledTimes(3);
    });

    it('never under memory pressure, though playback alone does not stop it', async () => {
      const h = fixture();
      pressure.pause = 'memory';
      await h.service.capture(owner, at(0));
      expect(h.encoder.read).not.toHaveBeenCalled();
      pressure.pause = 'playback';
      await h.service.capture(owner, at(1));
      expect(h.encoder.read).toHaveBeenCalledOnce();
    });

    it('never when the cache has no room, without reading back', async () => {
      const h = fixture(); h.hasRoom.mockReturnValue(false);
      await expect(h.service.capture(owner, at(0))).resolves.toMatchObject({ kind: 'texture' });
      expect(h.encoder.read).not.toHaveBeenCalled();
    });

    describe('on a bitmap host', () => {
      it('from the pixels it delivers, without holding the display for the write', async () => {
        const h = fixture(false); let finish!: () => void;
        h.writer.encoded.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
        await expect(h.service.capture(owner, at(3))).resolves.toMatchObject({ kind: 'pixels', width: 2, height: 2, persisted: false });
        expect(h.prepareWrite).toHaveBeenCalledExactlyOnceWith(bake.hash, 3);
        await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM));
        expect(h.pixels.straighten).toHaveBeenCalledOnce();
        finish();
      });

      it('never while two frames are in flight; the third is still delivered', async () => {
        const h = fixture(false);
        h.writer.encoded.mockReturnValue(new Promise<void>(() => {}));
        for (const frame of [0, 1, 2]) await expect(h.service.capture(owner, at(frame))).resolves.toMatchObject({ kind: 'pixels' });
        await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledTimes(2));
      });

      it('never under memory pressure or without room', async () => {
        const h = fixture(false);
        pressure.pause = 'memory';
        await h.service.capture(owner, at(0));
        pressure.pause = undefined; h.hasRoom.mockReturnValue(false);
        await h.service.capture(owner, at(1));
        expect(h.prepareWrite).not.toHaveBeenCalled();
      });

      it('and a failed write does not reach the display', async () => {
        const h = fixture(false);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        h.writer.encoded.mockRejectedValue(new Error('disk full'));
        await expect(h.service.capture(owner, at(0))).resolves.toMatchObject({ kind: 'pixels', persisted: false });
        await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
        warn.mockRestore();
      });

      it('and a parameter preview, which has no cache address, stores nothing', async () => {
        const h = fixture(false);
        await expect(h.service.capture(owner, preview())).resolves.toMatchObject({ kind: 'pixels', persisted: false });
        expect(h.prepareWrite).not.toHaveBeenCalled();
      });
    });

    it('after a session switch to bitmaps too', async () => {
      const h = fixture();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.failNext(new Error('OSR unavailable'));
      await expect(h.service.capture(owner, at(0))).resolves.toMatchObject({ kind: 'pixels', persisted: false });
      await vi.waitFor(() => expect(h.writer.encoded).toHaveBeenCalledExactlyOnceWith(BITMAP_WFRM));
      warn.mockRestore();
    });

    it('and a failed write reaches neither the display nor the GPU path, and warns once', async () => {
      const h = fixture();
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
      const h = fixture();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.encoder.read.mockRejectedValue(new MotifError('device', 'device unavailable'));
      await expect(h.service.capture(owner, at(0))).resolves.toMatchObject({ kind: 'texture' });
      await expect(h.service.capture(owner, at(1))).resolves.toMatchObject({ kind: 'pixels' });
      expect(h.encoder.read).toHaveBeenCalledOnce();
      expect(h.deps.copy).toHaveBeenCalledOnce();
      warn.mockRestore();
    });
  });
});

describe('Motif capture wire', () => {
  const valid = { ...args, requestId: 3, priority: 'ahead', address: bake, store: 'keep', afterMiss: true, finalizationToken: 'fin', fpsNum: 30, fpsDen: 1 };

  it('parses a request and drops what it does not know', () => {
    expect(parseMotifCaptureRequest({ ...valid, coalesceKey: 'old', address: { ...bake, extra: 1 } })).toEqual(valid);
    expect(parseMotifCaptureRequest({ ...args, requestId: 0, priority: 'current' })).toEqual({ ...args, requestId: 0, priority: 'current' });
  });

  it.each([
    ['no request id', { requestId: undefined }], ['a fractional request id', { requestId: 1.5 }], ['an unknown priority', { priority: 'high' }],
    ['a bad address', { address: { hash: 'x', frame: 0 } }], ['an unknown store mode', { store: 'bake' }], ['a non-boolean afterMiss', { afterMiss: 1 }],
    ['no size', { width: 0 }], ['no time', { tSec: Number.NaN }],
  ])('refuses %s', (_name, change) => {
    expect(() => parseMotifCaptureRequest({ ...valid, ...change })).toThrow('Invalid Motif capture request');
  });

  it('parses controls; anything else is not one', () => {
    expect(parseMotifCaptureControl({ requestId: 2, action: 'cancel' })).toEqual({ requestId: 2, action: 'cancel' });
    expect(parseMotifCaptureControl({ requestId: 2, action: 'priority', priority: 'background' })).toEqual({ requestId: 2, action: 'priority', priority: 'background' });
    for (const control of [null, { key: 'k', action: 'promote' }, { requestId: 2, action: 'priority', priority: 'high' }, { requestId: -1, action: 'cancel' }]) {
      expect(parseMotifCaptureControl(control)).toBeNull();
    }
  });

  it('parses a presence; anything else is not one', () => {
    const shown = { motifId: 'm', contentHash: 'h' };
    const next = { motifId: 'n', contentHash: '', inMs: 120, width: 1920, height: 1080 };
    expect(parseMotifPresence({ visible: [shown], next, playing: true })).toEqual({ visible: [shown], next, playing: true });
    expect(parseMotifPresence({ visible: [], next: null, playing: false })).toEqual({ visible: [], next: null, playing: false });
    for (const presence of [null, { visible: 'm', next: null, playing: true }, { visible: [], next: null }, { visible: [{ motifId: '' , contentHash: 'h' }], next: null },
      { visible: [shown], playing: true }, { visible: [], next: { ...next, inMs: -1 }, playing: true },
      { visible: [], next: { ...next, width: 0 }, playing: true }, { visible: [], next: { ...next, height: 1.5 }, playing: true },
      { visible: Array.from({ length: 257 }, () => shown), next: null }]) {
      expect(parseMotifPresence(presence)).toBeNull();
    }
  });
});
