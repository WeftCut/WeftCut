import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summaryFixture, compositionFixture } from "../testing/summaryFixture";
import type { LayerSummary, TrackSummary } from "../ipc";
import { exportMotifPlanner, planExportMotifFrame } from "./exportMotifSource";
import { sharedBakedKeyIndex, sharedMotifFrameCache } from "./motifs/motifRasterCache";
import { captureMotifFrameResult } from "./motifs/host";
import { controlStoredMotifCapture } from "./motifs/frameTransport";
import { timeUsAtFrame } from "../frames";

vi.mock("./motifs/motifRasterCache", () => ({
  sharedBakedKeyIndex: { has: vi.fn(() => true), add: vi.fn() },
  sharedMotifFrameCache: { readBitmap: vi.fn(), writeFrame: vi.fn() },
}));
vi.mock("./motifs/host", () => ({ captureMotifFrameResult: vi.fn() }));
vi.mock("./motifs/frameTransport", () => ({ controlStoredMotifCapture: vi.fn() }));

const stat = (value: number) => ({ mode: "Static", value });
function motif(id = 'm', start = 0, end = 5_000_000): LayerSummary {
  return { id, enabled: true, t_start_us: start, t_end_us: end, effects: [], params: {
    kind: "Motif", motif_id: "countdown", props: { seconds: 5 }, src_in_us: 0,
    x: stat(0), y: stat(0), scale_x: stat(1), scale_y: stat(1), rotation_deg: stat(0), opacity: stat(1),
  } } as unknown as LayerSummary;
}
const track = (layers: LayerSummary[]): TrackSummary => ({ id: 't', enabled: true, layers }) as TrackSummary;
const summary = () => summaryFixture({ root: { duration_us: 5_000_000, fps_num: 60, fps_den: 1, tracks: [track([motif()])] } });
const bitmap = () => ({ width: 480, height: 480, close: vi.fn() }) as unknown as ImageBitmap;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(sharedBakedKeyIndex.has).mockReturnValue(true);
  vi.stubGlobal('OffscreenCanvas', class {
    width = 480; height = 480;
    getContext() { return { drawImage: vi.fn() }; }
    async convertToBlob() { return new Blob(['pixels']); }
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('streamed Motif selection', () => {
  it('samples only output frames, including a non-grid range start and repeated composition frames', () => {
    const p = summary();
    const lower = exportMotifPlanner(p, 3_001_000, 30, 1);
    expect([0, 1, 2].map(i => lower(i)[0]!.frame)).toEqual([180, 182, 184]);
    const higher = exportMotifPlanner(p, 0, 120, 1);
    expect([0, 1, 2, 3].map(i => higher(i)[0]!.frame)).toEqual([0, 0, 1, 1]);
    expect(planExportMotifFrame(p, 5_000_000)).toEqual([]);
  });

  it('keeps separate Group placements and their source windows on the rational composition grid', () => {
    const fps = { num: 30000, den: 1001 }, at = (i: number) => timeUsAtFrame(i, fps.num, fps.den);
    const ref = (id: string, start: number, src: number): LayerSummary => ({
      id, enabled: true, t_start_us: start, t_end_us: at(90),
      params: { kind: 'CompositionRef', composition_id: 'child', src_in_us: src },
    }) as LayerSummary;
    const p = summaryFixture({ root: { fps_num: fps.num, fps_den: fps.den, tracks: [track([ref('a', at(2), 0), ref('b', at(3), at(10))])] },
      groups: [compositionFixture({ id: 'child', tracks: [track([motif('m', at(2), at(100))])] })] });
    const tasks = planExportMotifFrame(p, at(4));
    expect(tasks.map(t => t.layerId)).toEqual(['a/m', 'b/m']);
    expect(tasks.map(t => t.frame)).toEqual([0, 9]);
  });

  it('reuses disk frames without capturing or writing', async () => {
    const b = bitmap(); vi.mocked(sharedMotifFrameCache.readBitmap).mockResolvedValue(b);
    expect(await planExportMotifFrame(summary(), 0)[0]!.read(new AbortController().signal)).toBe(b);
    expect(captureMotifFrameResult).not.toHaveBeenCalled();
    expect(sharedMotifFrameCache.writeFrame).not.toHaveBeenCalled();
  });

  it('persists cold export frames in main without drawing or encoding pixels again in the renderer', async () => {
    const b = bitmap();
    vi.mocked(sharedBakedKeyIndex.has).mockReturnValue(false);
    vi.mocked(captureMotifFrameResult).mockResolvedValue({ bitmap: b, persisted: true });
    const canvas = vi.fn(() => { throw new Error('No renderer encode expected'); });
    vi.stubGlobal('OffscreenCanvas', canvas);
    const task = planExportMotifFrame(summary(), 1_000_000, 'export-token')[0]!;
    expect(await task.read(new AbortController().signal)).toBe(b);
    expect(captureMotifFrameResult).toHaveBeenCalledOnce();
    expect(vi.mocked(captureMotifFrameResult).mock.calls[0]?.[9]).toMatchObject({
      bake: { hash: expect.stringMatching(/^[0-9a-f]{32}$/), frame: 60 },
      bakeOptional: true, finalizationToken: 'export-token', high: true,
    });
    expect(canvas).not.toHaveBeenCalled();
    expect(sharedMotifFrameCache.writeFrame).not.toHaveBeenCalled();
    expect(sharedBakedKeyIndex.add).toHaveBeenCalledWith(expect.any(String), 60);
  });

  it.each(['missing', 'corrupt', 'unbaked'])('repairs a %s frame and makes it reusable', async kind => {
    const b = bitmap(); vi.mocked(captureMotifFrameResult).mockResolvedValue({ bitmap: b, persisted: false });
    if (kind === 'corrupt') vi.mocked(sharedMotifFrameCache.readBitmap).mockRejectedValue(new Error('bad cache'));
    else vi.mocked(sharedMotifFrameCache.readBitmap).mockResolvedValue(null);
    if (kind === 'unbaked') vi.mocked(sharedBakedKeyIndex.has).mockReturnValue(false);
    const task = planExportMotifFrame(summary(), 0)[0]!;
    expect(await task.read(new AbortController().signal)).toBe(b);
    expect(sharedMotifFrameCache.writeFrame).toHaveBeenCalledOnce();
    expect(sharedBakedKeyIndex.add).toHaveBeenCalledOnce();
  });

  it('continues with valid pixels when cache persistence fails, and propagates capture failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = bitmap(); vi.mocked(captureMotifFrameResult).mockResolvedValueOnce({ bitmap: b, persisted: false });
    vi.mocked(sharedMotifFrameCache.writeFrame).mockRejectedValue(new Error('disk full'));
    const task = planExportMotifFrame(summary(), 0)[0]!;
    expect(await task.read(new AbortController().signal)).toBe(b);
    expect(b.close).not.toHaveBeenCalled(); expect(sharedBakedKeyIndex.add).not.toHaveBeenCalled();
    vi.mocked(captureMotifFrameResult).mockRejectedValueOnce(new Error('capture failed'));
    await expect(task.read(new AbortController().signal)).rejects.toThrow('capture failed');
  });

  it('cancels an admitted capture and skips cache writes for late results', async () => {
    let resolve!: (v: { bitmap: ImageBitmap; persisted: boolean }) => void;
    vi.mocked(captureMotifFrameResult).mockReturnValue(new Promise(r => { resolve = r; }));
    const ctrl = new AbortController();
    const read = planExportMotifFrame(summary(), 0)[0]!.read(ctrl.signal);
    await vi.waitFor(() => expect(captureMotifFrameResult).toHaveBeenCalledOnce());
    ctrl.abort();
    expect(controlStoredMotifCapture).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel' }));
    const b = bitmap(); resolve({ bitmap: b, persisted: false });
    expect(await read).toBe(b); // producer owns and closes this late result
    expect(sharedMotifFrameCache.writeFrame).not.toHaveBeenCalled();
  });
});
