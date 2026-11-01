import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExportResourcePlans, peakDecoderMiB, prepareExportResourcePlans } from './exportResourcePlan';
import { exportDecoderMiB, minimumExportFrames, type ExportResourceBlock } from '../../shared/export-resources';
import type { MediaSummary, ProjectSummary } from '../ipc';
import type { ExportDecodeRouting } from './exportDecodeRouting';

describe('export working-set plans', () => {
  it('fits the real 2304 MiB Main10 target by reducing dispatch, retaining private surfaces and quality', () => {
    const minimumFrames=minimumExportFrames({codec:'avc1.6e0028',codedWidth:1920,codedHeight:1080});
    expect(minimumFrames).toBe(12);
    const plans=buildExportResourcePlans({sources:{a:{width:1920,height:1080,tenBit:true,minimumFrames}},
      clips:[{key:'a',mediaId:'a',start:0,end:100}],workerMiB:191,encoderMiB:192,motifBufferBytes:0});
    expect(plans[0]!.memoryMiB).toBeGreaterThan(921);
    expect(plans.at(-1)!.memoryMiB).toBeLessThanOrEqual(921);
    expect(plans.at(-1)!.frameWindows.a).toBe(12);
    expect(plans.at(-1)!.memoryMiB).toBe(191+192+exportDecoderMiB(1920,1080,true,12));
  });
  it('retains the shipping window when coded level or codec does not establish a smaller bound', () => {
    for (const codec of ['avc1.640033','av01.0.08M.08','hvc1.1.6.L120','avc1','avc1.6400ff']) {
      expect(minimumExportFrames({codec,codedWidth:640,codedHeight:360})).toBe(24);
    }
    expect(minimumExportFrames({codec:'avc1.640028'})).toBe(24);
  });
  it('counts simultaneous decode identities, sharing one phase and releasing at exact cuts', () => {
    const a={key:'a:0',mediaId:'a',start:0,end:10};
    expect(peakDecoderMiB([a,{...a,start:2,end:9},{key:'b',mediaId:'b',start:10,end:20}],{a:381,b:500})).toBe(500);
    expect(peakDecoderMiB([a,{...a,key:'a:1',start:5,end:15}],{a:381})).toBe(762);
    expect(peakDecoderMiB([a,{key:'b',mediaId:'b',start:5,end:15}],{a:381,b:500})).toBe(881);
  });
  it('reduces Motif concurrency and buffering without reducing per-frame working memory', () => {
    const plans=buildExportResourcePlans({sources:{},clips:[],workerMiB:335,encoderMiB:192,
      motifBufferBytes:144*1048576,motifFrameBytes:16*1048576,captureMiB:175});
    expect(plans[0]!.memoryMiB).toBeGreaterThan(921);
    const minimum=plans.at(-1)!;
    expect(minimum.motifFrames).toBe(1);
    expect(minimum.motifBufferBytes).toBe(16*1048576);
    expect(minimum.memoryMiB).toBe(207+192+175);
  });
  it('uses native metadata estimates and keeps an admitted tail for source-free exports', () => {
    expect(buildExportResourcePlans({sources:{},clips:[],workerMiB:32,encoderMiB:0,motifBufferBytes:0})[0]!.memoryMiB).toBe(64);
    // The audio mix borrows from the plan before any video child exists: a
    // floor, not an addend.
    expect(buildExportResourcePlans({sources:{},clips:[],workerMiB:32,encoderMiB:0,motifBufferBytes:0,audioMiB:128})[0]!.memoryMiB).toBe(128);
    expect(buildExportResourcePlans({sources:{},clips:[],workerMiB:300,encoderMiB:0,motifBufferBytes:0,audioMiB:128})[0]!.memoryMiB).toBe(300);
    const plan=buildExportResourcePlans({sources:{a:{width:1,height:1,tenBit:false,minimumFrames:24,nativeMiB:456}},
      clips:[{key:'a',mediaId:'a',start:0,end:1}],workerMiB:100,encoderMiB:200,motifBufferBytes:0});
    expect(plan).toHaveLength(1); expect(plan[0]!.memoryMiB).toBe(756);
  });
});

describe('metadata preflight admission', () => {
  const clip = { id: 'L', label: null, t_start_us: 0, t_end_us: 1_000_000, kind: 'VideoClip', color_hint: '#000', enabled: true, locked: false, effects: [],
    params: { kind: 'VideoClip', media_id: 'm1', media_label: '', src_in_us: 0, src_out_us: 1_000_000, x: 0, y: 0, scale_x: 1, scale_y: 1, opacity: 1, speed: 1,
      flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0 } };
  const summary = { root_id: 'root', compositions: { root: { id: 'root', width: 1280, height: 720, fps_num: 30, fps_den: 1, duration_us: 1_000_000,
    tracks: [{ enabled: true, layers: [clip] }] } } } as unknown as ProjectSummary;
  const media = new Map([['m1', { id: 'm1', label: 'clip', path: '/media/clip.mp4' } as unknown as MediaSummary]]);
  const routing = { routes: { m1: { engine: 'native', sourcePath: '/media/clip.mp4' } } } as unknown as ExportDecodeRouting;
  const blocked: ExportResourceBlock = { kind: 'blocked', reason: 'busy', requestedMiB: 64, availableMiB: 0, workMiB: 1024, revision: 3,
    holders: [{ kind: 'proxy', media_id: 'm1', mib: 1024, threads: 1 }] };
  // Main's admission: queued while a proxy build holds the whole budget, then
  // admitted when it releases. It reports the block and has no deadline.
  function bridge() {
    let listener: ((event: ExportResourceBlock & { id: string }) => void) | undefined;
    let releaseHolder!: () => void;
    const queued = new Map<string, (error: Error) => void>();
    const planExport = vi.fn(async (request: { id: string; options: number[] }) => {
      listener?.({ id: request.id, ...blocked });
      await new Promise<void>((resolve, reject) => { releaseHolder = resolve; queued.set(request.id, reject); });
      queued.delete(request.id);
      return 0;
    });
    const estimateDecoder = vi.fn(async () => 300);
    // Releasing a queued request aborts main's wait, which rejects the invoke.
    const release = vi.fn((id: string) => { queued.get(id)?.(new Error('Export cancelled')); queued.delete(id); });
    vi.stubGlobal('window', { api: { resources: { planExport, estimateDecoder, release,
      onExportWaiting: (cb: typeof listener) => { listener = cb; return () => { listener = undefined; }; } } } });
    return { planExport, estimateDecoder, release, releaseHolder: () => releaseHolder() };
  }
  const input = (signal: AbortSignal, waiting: (block: ExportResourceBlock) => void) =>
    ({ summary, media, routing, startUs: 0, endUs: 1_000_000, bitDepth: 8 as const, nativeEncoder: false, outputWidth: 1280, outputHeight: 720, signal, waiting });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('a source read behind a full budget waits queued, without failing busy, and is admitted once the holder releases', async () => {
    vi.useFakeTimers();
    const b = bridge(), waiting = vi.fn();
    let settled = false;
    const pending = prepareExportResourcePlans(input(new AbortController().signal, waiting)).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false);
    expect(waiting).toHaveBeenCalledWith(blocked);
    expect(b.planExport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ options: [64], nativeEncoder: false }));
    expect(b.estimateDecoder).not.toHaveBeenCalled();
    b.releaseHolder();
    const plans = await pending;
    expect(plans[0]!.frameWindows).toHaveProperty('m1');
    expect(b.estimateDecoder).toHaveBeenCalledOnce();
    // The metadata admission is returned once the sources are read.
    expect(b.release).toHaveBeenCalledOnce();
  });

  it('cancelling the queued wait rejects and withdraws the request', async () => {
    const b = bridge(), controller = new AbortController();
    const pending = prepareExportResourcePlans(input(controller.signal, () => {}));
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(b.planExport).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(b.release).toHaveBeenCalledExactlyOnceWith(b.planExport.mock.calls[0]![0].id);
    expect(b.estimateDecoder).not.toHaveBeenCalled();
  });
});
