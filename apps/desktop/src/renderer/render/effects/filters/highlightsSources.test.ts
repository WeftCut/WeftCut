// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { HIGHLIGHTS_FRAG_GL, HIGHLIGHTS_WGSL } from "./highlightsSources";
import { highlightsReference } from "./highlightsReference";

const grey = (value: number, strength: number) => highlightsReference([value, value, value, 1], strength)[0]!;

describe("highlights adjustment strength", () => {
  it("zero strength is an exact pass-through, including transparent colour", () => {
    for (const p of [[.8,.7,.6,1], [.15,.1,.05,.25], [.1,.2,.3,0]] as [number,number,number,number][]) {
      expect(highlightsReference(p, 0)).toEqual(p);
    }
  });

  it("protects darker tones throughout the entire strength range", () => {
    for (const amount of [-100, -75, -50, -25, 25, 100]) {
      for (const value of [0, .05, .1, .2, .29]) {
        expect(highlightsReference([value,value,value,1], amount)).toEqual([value,value,value,1]);
      }
    }
    expect(grey(1, -100)).toBeCloseTo(.44, 12);
  });

  it("never reverses tone order or exceeds SDR bounds", () => {
    for (const amount of [-100, -99, -75, -50, -25, -1, 1, 25, 50, 100]) {
      let last = -1;
      for (let i=0; i<=4096; i++) {
        const v=i/4096;
        const [r,g,b,a]=highlightsReference([v,v,v,1], amount);
        expect(r!).toBeGreaterThanOrEqual(last);
        expect(r).toBe(g);
        expect(g).toBe(b);
        expect(a).toBe(1);
        expect(r!).toBeGreaterThanOrEqual(0);
        expect(r!).toBeLessThanOrEqual(1);
        if (amount<0) expect(r!).toBeLessThanOrEqual(v+1e-12);
        if (amount>0) expect(r!).toBeGreaterThanOrEqual(v-1e-12);
        last=r!;
      }
    }
  });

  it("preserves warm colour ratios and partial alpha when lowering highlights", () => {
    const full=highlightsReference([.92,.74,.55,1],-40);
    const partial=highlightsReference([.46,.37,.275,.5],-40);
    expect(full[0]!/full[1]!).toBeCloseTo(.92/.74,12);
    expect(full[1]!/full[2]!).toBeCloseTo(.74/.55,12);
    for (let i=0;i<3;i++) expect(partial[i]).toBeCloseTo(full[i]!*.5,12);
    expect(partial[3]).toBe(.5);
  });

  it("uses strength to compress bright tones rather than a literal percent multiplier", () => {
    expect(grey(.4,-40)).toBeCloseTo(.3813953488372093,12);
    expect(grey(.6,-40)).toBeCloseTo(.4779661016949152,12);
    expect(grey(.8,-40)).toBeCloseTo(.5333333333333333,12);
    expect(grey(.4,40)).toBeCloseTo(.4047904191616767,12);
    expect(grey(.6,40)).toBeCloseTo(.647682119205298,12);
    expect(grey(.8,-25)).not.toBeCloseTo(.8*.75,3);
    // Higher input brightness receives progressively greater relative reduction.
    expect(1-grey(.4,-25)/.4).toBeLessThan(1-grey(.6,-25)/.6);
    expect(1-grey(.6,-25)/.6).toBeLessThan(1-grey(1,-25));
    for (const v of [.4,.6,.8,1]) {
      expect(grey(v,-50)).toBeLessThan(grey(v,-25));
      expect(grey(v,25)).toBeLessThanOrEqual(grey(v,50));
    }
  });

  it("joins protected tones smoothly at a fixed boundary for every strength", () => {
    for (const amount of [-100,-75,-25,25,100]) {
      const eps=1e-7;
      expect(grey(.3,amount)).toBeCloseTo(.3,12);
      expect((grey(.3+eps,amount)-grey(.3,amount))/eps).toBeCloseTo(1,4);
    }
  });

  it("uses the same plain-JS shader source in the GPU gate", () => {
    const text=readFileSync(new URL('./highlightsSources.ts',import.meta.url),'utf8').replace(/^export /gm,'');
    const shader=new Function(text+';return HIGHLIGHTS_FRAG_GL')();
    expect(shader).toBe(HIGHLIGHTS_FRAG_GL);
    expect(HIGHLIGHTS_FRAG_GL.startsWith('#version 300 es\nprecision highp float;')).toBe(true);
    expect(HIGHLIGHTS_WGSL).toContain('mainVertex');
    expect(HIGHLIGHTS_WGSL).toContain('mainFragment');
  });
});
