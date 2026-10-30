import { describe, expect, it, vi } from 'vitest';
import { FrameBroker, type FrameTicket } from './FrameBroker';
import { MotifFrameCache } from './frameCache';
import type { CapturedFrame } from './frameTransport';

function bitmap() { return { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function setup() {
  const cache = new MotifFrameCache(4);
  const clone = vi.fn(async (_source: ImageBitmap) => bitmap());
  const control = vi.fn();
  return { cache, clone, control, broker: new FrameBroker({ cache, clone, control }) };
}

describe('FrameBroker ownership and subscribers', () => {
  it('attaches bake intent to an existing preview capture without a second producer', async () => {
    const h = setup(), wait = deferred<CapturedFrame>();
    let ticket!: FrameTicket;
    const capture = vi.fn((t: FrameTicket) => { ticket = t; return wait.promise; });
    const preview = h.broker.acquire('c', 0, 1, capture, 'sprite');
    await flush();
    expect(ticket.bake()).toBeUndefined();
    const address = { hash: 'hash', frame: 0 };
    const bake = h.broker.acquire('c', 0, 1, capture, undefined, address);
    expect(ticket.bake()).toEqual(address);
    expect(h.control).toHaveBeenCalledWith(ticket.key, 'bake', address);
    wait.resolve({ bitmap: bitmap(), persisted: true, scaleDiv: 'live' as const });
    expect((await bake).persisted).toBe(true);
    await preview;
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('a workspace reset prevents a new bake from inheriting the old write acknowledgement', async () => {
    const h = setup(), old = deferred<CapturedFrame>();
    const first = h.broker.acquire('c', 0, 1, () => old.promise);
    await flush(); h.broker.reset();
    const capture = vi.fn(async () => ({ bitmap: bitmap(), persisted: false, scaleDiv: 'live' as const }));
    expect((await h.broker.acquire('c', 0, 1, capture)).persisted).toBe(false);
    old.resolve({ bitmap: bitmap(), persisted: true, scaleDiv: 'live' as const });
    expect((await first).persisted).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('one capture serves preview/prewarm/bake with independently owned results', async () => {
    const h = setup(), source = bitmap();
    const capture = vi.fn(async () => ({ bitmap: source, persisted: true, scaleDiv: 'live' as const }));
    const results = await Promise.all([
      h.broker.acquire('content', 0, 1, capture), h.broker.acquire('content', 0, 1, capture),
      h.broker.acquire('content', 0, 1, capture, 'sprite:1'),
    ]);
    await flush();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(new Set(results.map(r => r.bitmap)).size).toBe(3);
    expect(results.every(r => r.persisted)).toBe(true);
    expect(source.close).toHaveBeenCalledTimes(1);
    results[0]!.bitmap.close();
    expect(results[1]!.bitmap.close).not.toHaveBeenCalled();
    // Producer never inserts potentially obsolete prewarm work into L0.
    expect(h.cache.size()).toBe(0);
  });

  it('pins an L0 hit until cloning finishes, even when eviction happens mid-clone', async () => {
    const h = setup(), source = bitmap(), copy = bitmap();
    h.cache.setFrame('c', 0, 1, source);
    const wait = deferred<ImageBitmap>(); h.clone.mockReturnValue(wait.promise);
    const capture = vi.fn();
    const request = h.broker.acquire('c', 0, 1, capture);
    await flush(); h.cache.setFrame('other', 0, 1, bitmap());
    expect(source.close).not.toHaveBeenCalled();
    wait.resolve(copy);
    expect(await request).toEqual({ bitmap: copy, persisted: false, scaleDiv: 1 });
    await flush();
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(copy.close).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it('superseding a sprite does not cancel the bake sharing its capture', async () => {
    const h = setup(), wait = deferred<CapturedFrame>();
    let ticket!: FrameTicket;
    const produce = vi.fn((t: FrameTicket) => { ticket = t; return wait.promise; });
    const bake = h.broker.acquire('c', 0, 1, produce);
    await flush(); expect(ticket.high()).toBe(false);
    const old = h.broker.acquire('c', 0, 1, produce, 'sprite:1');
    const rejected = expect(old).rejects.toThrow('superseded');
    expect(ticket.high()).toBe(true);
    expect(h.control).toHaveBeenCalledWith(ticket.key, 'promote');
    const fresh = h.broker.acquire('c', 1, 1, async () => ({ bitmap: bitmap(), persisted: false, scaleDiv: 'live' as const }), 'sprite:1');
    await rejected;
    expect(ticket.wanted()).toBe(true);
    expect(h.control).not.toHaveBeenCalledWith(ticket.key, 'cancel');
    wait.resolve({ bitmap: bitmap(), persisted: true, scaleDiv: 'live' as const });
    expect((await bake).persisted).toBe(true); await fresh;
  });

  it('cancels an abandoned queued frame and closes a late running result', async () => {
    const h = setup(), wait = deferred<CapturedFrame>(), source = bitmap();
    let key = '';
    const old = h.broker.acquire('c', 0, 1, t => { key = t.key; return wait.promise; }, 'sprite:1');
    const rejected = expect(old).rejects.toThrow('superseded');
    await flush();
    const next = h.broker.acquire('c', 1, 1, async () => ({ bitmap: bitmap(), persisted: false, scaleDiv: 'live' as const }), 'sprite:1');
    await rejected; expect(h.control).toHaveBeenCalledWith(key, 'cancel');
    wait.resolve({ bitmap: source, persisted: false, scaleDiv: 'live' as const });
    await next; await flush();
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(h.clone).toHaveBeenCalledTimes(1); // only the still-wanted frame
  });

  it('explicit cursor cancellation releases only its subscriber, preserving a shared bake', async () => {
    const h = setup(), wait = deferred<CapturedFrame>();
    let ticket!: FrameTicket;
    const capture = vi.fn((t: FrameTicket) => { ticket = t; return wait.promise; });
    const bake = h.broker.acquire('c', 0, 1, capture);
    const preview = h.broker.acquire('c', 0, 1, capture, 'instance');
    const rejected = expect(preview).rejects.toThrow('superseded');
    await flush();
    h.broker.cancel('instance');
    await rejected;
    expect(ticket.wanted()).toBe(true);
    expect(h.control).not.toHaveBeenCalledWith(ticket.key, 'cancel');
    wait.resolve({ bitmap: bitmap(), persisted: true, scaleDiv: 'live' as const });
    expect((await bake).persisted).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('retires failures so the same frame can be retried', async () => {
    const h = setup();
    const capture = vi.fn().mockRejectedValueOnce(new Error('GPU lost')).mockResolvedValue({ bitmap: bitmap(), persisted: false, scaleDiv: 'live' as const });
    await expect(h.broker.acquire('c', 0, 1, capture)).rejects.toThrow('GPU lost');
    await flush();
    await h.broker.acquire('c', 0, 1, capture);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('one clone failure does not close a sibling result', async () => {
    const h = setup(), source = bitmap();
    h.clone.mockRejectedValueOnce(new Error('clone failed'));
    const capture = async () => ({ bitmap: source, persisted: false, scaleDiv: 'live' as const });
    const failed = h.broker.acquire('c', 0, 1, capture);
    const sibling = h.broker.acquire('c', 0, 1, capture);
    await expect(failed).rejects.toThrow('clone failed');
    const result = await sibling; await flush();
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(result.bitmap.close).not.toHaveBeenCalled();
  });

  it('a divisor is part of the request identity, and results keep the size they came back at', async () => {
    const h = setup(), half = bitmap(), live = bitmap();
    const read = vi.fn(async () => ({ bitmap: half, persisted: true, scaleDiv: 2 as const }));
    const capture = vi.fn(async () => ({ bitmap: live, persisted: false, scaleDiv: 'live' as const }));
    const [a, b] = await Promise.all([h.broker.acquire('c', 0, 2, read), h.broker.acquire('c', 0, 1, capture)]);
    expect([read, capture].map(fn => fn.mock.calls.length)).toEqual([1, 1]);
    expect([a.scaleDiv, b.scaleDiv]).toEqual([2, 'live']);
  });

  it('different brokers and different content identities cannot coalesce capture tickets', async () => {
    const a = setup(), b = setup(), keys: string[] = [];
    const capture = async (t: FrameTicket) => { keys.push(t.key); return { bitmap: bitmap(), persisted: false, scaleDiv: 'live' as const }; };
    await Promise.all([a.broker.acquire('committed', 0, 1, capture), b.broker.acquire('overlay', 0, 1, capture), a.broker.acquire('changed-props', 0, 1, capture)]);
    expect(new Set(keys).size).toBe(3);
  });
});
