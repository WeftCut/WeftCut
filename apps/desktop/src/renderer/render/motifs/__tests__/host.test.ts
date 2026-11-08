import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@/bridge/ipc", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('../frameTransport', () => ({ captureMotif: vi.fn() }));

import { captureMotifFrame, captureMotifFramePngBlob } from "../host";
import { captureMotif } from '../frameTransport';

afterEach(() => vi.unstubAllGlobals());

describe("captureMotifFramePngBlob", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes motif_capture_frame and returns a PNG Blob of the returned bytes", async () => {
    // The channel returns the PNG as a Uint8Array (structured-clone native) —
    // main decodes CDP's base64 once; the renderer goes straight to Blob.
    invokeMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const blob = await captureMotifFramePngBlob("countdown", 2.5, { seconds: 5 }, 480, 480);
    expect(invokeMock).toHaveBeenCalledWith("motif_capture_frame", {
      motifId: "countdown",
      tSec: 2.5,
      propsJson: JSON.stringify({ seconds: 5 }),
      width: 480,
      height: 480,
      contentHash: "",
      fpsNum: null,
      fpsDen: null,
    });
    expect(blob.type).toBe("image/png");
    expect(await blob.arrayBuffer().then((b) => Array.from(new Uint8Array(b)))).toEqual([1, 2, 3]);
  });

  it("threads the composition fps through when given", async () => {
    invokeMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    await captureMotifFramePngBlob("countdown", 2.5, { seconds: 5 }, 480, 480, "hash", 30000, 1001);
    expect(invokeMock).toHaveBeenCalledWith("motif_capture_frame", expect.objectContaining({
      fpsNum: 30000,
      fpsDen: 1001,
    }));
  });
});

describe("captureMotifFrame", () => {
  it("captures unaddressed at current priority and returns the pixels", async () => {
    const bitmap = {} as ImageBitmap;
    vi.mocked(captureMotif).mockReturnValue({
      reply: Promise.resolve({ kind: 'pixels', bitmap, persisted: false }), setPriority: vi.fn(), cancel: vi.fn(),
    });
    await expect(captureMotifFrame('countdown', 2.5, { seconds: 5 }, 480, 480)).resolves.toBe(bitmap);
    expect(captureMotif).toHaveBeenCalledExactlyOnceWith({
      motifId: 'countdown', tSec: 2.5, propsJson: JSON.stringify({ seconds: 5 }),
      width: 480, height: 480, contentHash: '', priority: 'current',
    });
  });
});
