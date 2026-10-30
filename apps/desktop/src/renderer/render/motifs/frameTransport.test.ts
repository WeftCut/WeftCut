import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());
it('preserves deliberate optional-cache skipping across the preload port without marking the frame saved', async () => {
  vi.resetModules();
  const port = { onmessage: undefined as undefined | ((event: { data: unknown }) => void), start: vi.fn(), postMessage: vi.fn() };
  vi.stubGlobal('MessageChannel', class { port1 = port; port2 = {}; });
  vi.stubGlobal('window', { postMessage: vi.fn() });
  const { captureMotifResult } = await import('./frameTransport');
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  const request = captureMotifResult({ motifId: 'synthetic' });
  const id = port.postMessage.mock.calls[0]![0].id;
  port.onmessage!({ data: { id, bitmap, persisted: false, cacheWriteSkipped: true } });
  expect(await request).toEqual({ bitmap, persisted: false, cacheWriteSkipped: true });
  expect(bitmap.close).not.toHaveBeenCalled();
});
