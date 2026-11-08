import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summaryFixture, compositionFixture } from "../testing/summaryFixture";
import type { LayerSummary, TrackSummary } from "../ipc";
import { exportMotifPlanner, planExportMotifFrame } from "./exportMotifSource";
import { acquireMotifFrame } from "./motifs/motifFrameSource";
import { MotifTransportError } from "./motifs/frameTransport";
import { timeUsAtFrame } from "../frames";

vi.mock("./motifs/motifFrameSource", () => ({ acquireMotifFrame: vi.fn() }));

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

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

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

  it('gets each frame through one full-size export request that the stream then owns', async () => {
    const b = bitmap(), release = vi.fn();
    vi.mocked(acquireMotifFrame).mockResolvedValue({ bitmap: b, frame: 60, release });
    const signal = new AbortController().signal;
    expect(await planExportMotifFrame(summary(), 1_000_000, 'export-token')[0]!.read(signal)).toBe(b);
    const [desc, request] = vi.mocked(acquireMotifFrame).mock.calls[0]!;
    expect(desc).toMatchObject({ motifId: 'countdown', contentFrame: 60, fpsNum: 60, fpsDen: 1, renderW: 480, renderH: 480, overlayActive: false });
    // Export and finalization read full size, whatever preview's divisor.
    expect(request).toEqual({ scaleDiv: 1, priority: 'current', signal, purpose: 'export', finalizationToken: 'export-token' });
    expect(release).not.toHaveBeenCalled();
  });

  it('sends no token outside a finalized export, and a failure fails the read', async () => {
    vi.mocked(acquireMotifFrame).mockRejectedValue(new MotifTransportError('utility', 'closed'));
    const task = planExportMotifFrame(summary(), 0)[0]!;
    await expect(task.read(new AbortController().signal)).rejects.toBeInstanceOf(MotifTransportError);
    expect(vi.mocked(acquireMotifFrame).mock.calls[0]![1]).not.toHaveProperty('finalizationToken');
  });
});
