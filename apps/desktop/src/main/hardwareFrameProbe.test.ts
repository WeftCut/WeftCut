import { expect, it, vi } from 'vitest';
import { probeHardwareFrames, type FrameProbeBackend } from './hardwareFrameProbe';

function backend(format = 'I420P10') {
  let callback: Parameters<FrameProbeBackend['previewSwOpen']>[2];
  const fake: FrameProbeBackend = {
    previewSwOpen: vi.fn((_id, _path, cb) => { callback = cb; }),
    previewSwEnableFlow: vi.fn(), previewSwConsume: vi.fn(), previewSwClose: vi.fn(),
    previewSwRequestFrameAt: vi.fn((_id, target, requestId) => {
      setImmediate(() => callback(null, { receipt: requestId, requestId, format, width: 2, height: 2,
        data: new Uint8Array(format === 'I420P10' ? 12 : 6), ptsUs: target }));
    }),
  };
  return fake;
}
it('validates actual ten-bit copy-back and backward/forward seeks while returning every receipt', async () => {
  const fake = backend();
  await probeHardwareFrames(fake, '/fixture.mp4', 'vaapi', '/dev/dri/renderD129', 10);
  expect(vi.mocked(fake.previewSwRequestFrameAt).mock.calls.map(c => c[1])).toEqual([600000, 0, 800000]);
  expect(fake.previewSwConsume).toHaveBeenCalledTimes(3);
  expect(fake.previewSwClose).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fake.previewSwOpen).mock.calls[0]![7]).toBe('I420P10');
});
it('does not accept an eight-bit frame as a successful ten-bit decoder', async () => {
  const fake = backend('NV12');
  await expect(probeHardwareFrames(fake, '/fixture.mp4', 'nvdec', null, 10)).rejects.toThrow('mismatch');
  expect(fake.previewSwConsume).toHaveBeenCalledTimes(1);
  expect(fake.previewSwClose).toHaveBeenCalledTimes(1);
});
it('closes an opened decoder when requesting frames throws', async () => {
  const fake = backend();
  fake.previewSwRequestFrameAt = () => { throw new Error('driver failure'); };
  await expect(probeHardwareFrames(fake, '/fixture.mp4', 'vaapi', '/dev/dri/renderD129', 10)).rejects.toThrow('driver failure');
  expect(fake.previewSwClose).toHaveBeenCalledTimes(1);
});
