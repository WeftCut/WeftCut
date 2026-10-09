import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@/bridge/ipc", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('../frameTransport', () => ({ captureMotifResult: vi.fn() }));

import { captureMotifFramePngBlob, captureMotifFrameResult } from "../host";
import { captureMotifResult } from '../frameTransport';

afterEach(() => vi.unstubAllGlobals());

describe("captureMotifFramePngBlob", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes motif_capture_frame and returns a PNG Blob of the returned bytes", async () => {
    // The channel returns the PNG as a Uint8Array (structured-clone native) —
    // main decodes CDP's base64 once; the renderer goes straight to Blob.
    invokeMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const blob = await captureMotifFramePngBlob("countdown", 2.5, { seconds: 5 }, 480, 480, 1);
    expect(invokeMock).toHaveBeenCalledWith("motif_capture_frame", {
      motifId: "countdown",
      tSec: 2.5,
      propsJson: JSON.stringify({ seconds: 5 }),
      width: 480,
      height: 480,
      settleRafs: 1,
      contentHash: "",
      coalesceKey: null,
      fpsNum: null,
      fpsDen: null,
    });
    expect(blob.type).toBe("image/png");
    expect(await blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b)))).toEqual([1, 2, 3]);
  });

  it("threads the composition fps through when given", async () => {
    invokeMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    await captureMotifFramePngBlob("countdown", 2.5, { seconds: 5 }, 480, 480, 1, "hash", undefined, 30000, 1001);
    expect(invokeMock).toHaveBeenCalledWith("motif_capture_frame", expect.objectContaining({
      fpsNum: 30000,
      fpsDen: 1001,
    }));
  });

  it('passes optional main persistence and finalization ownership over the capture transport', async () => {
    vi.stubGlobal('window', { postMessage: vi.fn() });
    vi.stubGlobal('MessageChannel', class {});
    const bitmap = {} as ImageBitmap;
    vi.mocked(captureMotifResult).mockResolvedValue({ bitmap, persisted: true });
    const bake = { hash: 'a'.repeat(32), frame: 75 };
    await expect(captureMotifFrameResult('countdown', 2.5, { seconds: 5 }, 480, 480, 1,
      'revision', 30, 1, { key: 'export', high: true, bake, bakeOptional: true, finalizationToken: 'finalization' }))
      .resolves.toEqual({ bitmap, persisted: true });
    expect(captureMotifResult).toHaveBeenCalledWith(expect.objectContaining({
      bake, bakeOptional: true, finalizationToken: 'finalization', coalesceKey: 'export',
    }));
  });
});
