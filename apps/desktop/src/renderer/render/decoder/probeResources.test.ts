import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), acquire: vi.fn(), available: vi.fn() }));
vi.mock('./mediaInput', () => ({ openMediaInput: mocks.open }));
vi.mock('../resourceClient', () => ({
  acquireRenderResources: mocks.acquire,
  backgroundResourcesAvailable: mocks.available,
  resourcePressure: () => false,
}));
import { classifyWebcodecsDecodability } from './probeSourceDecodable';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let closes: number;
let releases: number;
let decoders: number;
let disposals: number;
let outputs: (() => void)[];
beforeEach(() => {
  vi.resetAllMocks(); closes = releases = decoders = disposals = 0; outputs = [];
  mocks.available.mockReturnValue(true);
  mocks.acquire.mockImplementation(async () => () => { releases++; });
  mocks.open.mockImplementation(async () => ({
    videoTrack: { getDecoderConfig: async () => ({ codec: 'avc1', codedWidth: 640, codedHeight: 360 }) },
    packetSink: { getKeyPacket: async () => ({ toEncodedVideoChunk: () => ({}) }) },
    dispose: () => { disposals++; },
  }));
  vi.stubGlobal('VideoDecoder', class {
    constructor(private handlers: { output: (frame: { close(): void }) => void }) { decoders++; }
    configure() {}
    decode() { outputs.push(() => this.handlers.output({ close() {} })); }
    flush() { return Promise.resolve(); }
    close() { closes++; }
    static isConfigSupported = async () => ({ supported: true });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('decode probe resource lifecycle', () => {
  it('coalesces a source across consumers and releases after decoder teardown', async () => {
    const a = classifyWebcodecsDecodability('shared');
    const b = classifyWebcodecsDecodability('shared');
    await settle();
    expect(decoders).toBe(1); expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    outputs[0]!();
    expect(await Promise.all([a, b])).toEqual(['ok', 'ok']);
    expect([closes, disposals, releases]).toEqual([1, 1, 2]);
  });
  it('keeps shared work for remaining consumers, aborts after the last leaves', async () => {
    const first = new AbortController(), second = new AbortController();
    const a = classifyWebcodecsDecodability('cancel', 2500, first.signal);
    const b = classifyWebcodecsDecodability('cancel', 2500, second.signal);
    await settle(); first.abort();
    expect(await a).toBe('unknown'); expect(closes).toBe(0);
    second.abort(); expect(await b).toBe('unknown'); await settle();
    expect([closes, disposals, releases]).toEqual([1, 1, 2]);
  });
  it('bounds concurrent sources and reports busy admission as unknown', async () => {
    const abort = new AbortController();
    const a = classifyWebcodecsDecodability('a', 2500, abort.signal);
    const b = classifyWebcodecsDecodability('b', 2500, abort.signal);
    expect(await classifyWebcodecsDecodability('c')).toBe('unknown');
    await settle(); expect(decoders).toBe(2);
    abort.abort(); await Promise.all([a, b]); await settle();
    mocks.acquire.mockRejectedValue(new Error('resources busy'));
    expect(await classifyWebcodecsDecodability('refused')).toBe('unknown');
    expect(decoders).toBe(2);
  });
  it('releases a late admission after its consumer cancels without opening input', async () => {
    let admit!: (release: () => void) => void;
    mocks.acquire.mockImplementationOnce(() => new Promise((resolve) => { admit = resolve; }));
    const abort = new AbortController();
    const result = classifyWebcodecsDecodability('late', 2500, abort.signal);
    abort.abort(); expect(await result).toBe('unknown');
    admit(() => { releases++; }); await settle();
    expect(releases).toBe(1); expect(mocks.open).not.toHaveBeenCalled();
  });
});
