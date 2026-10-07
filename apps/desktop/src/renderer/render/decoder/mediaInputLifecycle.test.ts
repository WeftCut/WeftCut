import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ track: vi.fn(), dispose: vi.fn(), abort: vi.fn(), sink: vi.fn(), construct: vi.fn() }));
vi.mock("mediabunny", () => ({
  MP4: {}, QTFF: {}, MATROSKA: {}, WEBM: {},
  Input: class { constructor() { mocks.construct(); } getPrimaryVideoTrack = mocks.track; dispose = mocks.dispose; },
  EncodedPacketSink: class { constructor() { mocks.sink(); } },
}));
vi.mock("./MediaRangeSource", () => ({ MediaRangeSource: class { source = {}; dispose = mocks.abort; } }));
import { openMediaInput } from "./mediaInput";

beforeEach(() => { vi.resetAllMocks(); mocks.track.mockResolvedValue({}); });
describe("media input ownership", () => {
  it.each(['read', 'missing-track', 'sink', 'constructor'])("aborts Range reads and disposes after %s failure", async (kind) => {
    if (kind === 'read') mocks.track.mockRejectedValue(new Error('read failure'));
    if (kind === 'missing-track') mocks.track.mockResolvedValue(null);
    if (kind === 'sink') mocks.sink.mockImplementation(() => { throw new Error('sink failure'); });
    if (kind === 'constructor') mocks.construct.mockImplementation(() => { throw new Error('input failure'); });
    await expect(openMediaInput('asset')).rejects.toThrow();
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.dispose).toHaveBeenCalledTimes(kind === 'constructor' ? 0 : 1);
  });
  it("cancels a read in progress and disposes idempotently", async () => {
    let finish!: (track: object) => void;
    mocks.track.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const abort = new AbortController();
    const pending = openMediaInput('asset', abort.signal);
    abort.abort(); finish({});
    await expect(pending).rejects.toThrow();
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
