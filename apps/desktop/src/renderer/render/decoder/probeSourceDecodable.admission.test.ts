import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ open: vi.fn(), acquire: vi.fn(), pressure: false }));
vi.mock('./mediaInput', () => ({ openMediaInput: mocks.open }));
vi.mock('../resourceClient', () => ({
  acquireRenderResources: mocks.acquire,
  backgroundResourcesAvailable: () => false,
  resourcePressure: () => mocks.pressure,
}));
import { classifyWebcodecsDecodability } from './probeSourceDecodable';
beforeEach(() => {
  mocks.pressure = false;
  mocks.acquire.mockResolvedValue(vi.fn());
  mocks.open.mockResolvedValue({ dispose: vi.fn(),
    videoTrack: { getDecoderConfig: async () => ({ codec: 'avc1.42001e' }) },
    packetSink: { getKeyPacket: async () => ({ toEncodedVideoChunk: () => ({}) }) },
  });
  vi.stubGlobal('VideoDecoder', class {
    constructor(private handlers: { output: (frame: { close: () => void }) => void }) {}
    configure() {}
    decode() { this.handlers.output({ close() {} }); }
    flush() { return Promise.resolve(); }
    close() {}
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('allows first-use probes during playback while optional background probes remain paused', async () => {
  expect(await classifyWebcodecsDecodability('/a')).toBe('unknown');
  expect(mocks.open).not.toHaveBeenCalled();
  expect(await classifyWebcodecsDecodability('/a', 2500, undefined, true)).toBe('ok');
  expect(mocks.acquire).toHaveBeenCalledTimes(2);
});
it('still obeys memory pressure for first-use probes', async () => {
  mocks.pressure = true;
  expect(await classifyWebcodecsDecodability('/a', 2500, undefined, true)).toBe('unknown');
  expect(mocks.acquire).not.toHaveBeenCalled();
});
