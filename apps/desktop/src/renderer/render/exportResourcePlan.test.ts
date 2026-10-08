import { describe, expect, it } from 'vitest';
import { buildExportResourcePlans, peakDecoderMiB } from './exportResourcePlan';
import { exportDecoderMiB, minimumExportFrames } from '../../shared/export-resources';

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
    const plan=buildExportResourcePlans({sources:{a:{width:1,height:1,tenBit:false,minimumFrames:24,nativeMiB:456}},
      clips:[{key:'a',mediaId:'a',start:0,end:1}],workerMiB:100,encoderMiB:200,motifBufferBytes:0});
    expect(plan).toHaveLength(1); expect(plan[0]!.memoryMiB).toBe(756);
  });
});
