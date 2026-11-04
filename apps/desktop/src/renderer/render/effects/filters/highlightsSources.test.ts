// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { HIGHLIGHTS_FRAG_GL, HIGHLIGHTS_WGSL, HIGHLIGHTS_UNIFORM_DEFAULTS } from "./highlightsSources";
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
      for (const value of [0, .05, .1, .2, .4, .44]) {
        expect(highlightsReference([value,value,value,1], amount)).toEqual([value,value,value,1]);
      }
    }
    expect(grey(1, -100)).toBe(1);
  });

  it("never reverses tone order or exceeds SDR bounds", () => {
    for (const amount of [-100, -99, -75, -50, -25, -1, 1, 25, 50, 100]) {
      let last = -1;
      for (let i=0; i<=4096; i++) {
        const v=i/4096;
        const [r,g,b,a]=highlightsReference([v,v,v,1], amount);
        expect(r!).toBeGreaterThanOrEqual(last - 1e-12);
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

  it("preserves white while adjusting bright tones in both directions", () => {
    for (const amount of [-100,-50,-10,0,50,100]) expect(grey(1,amount)).toBe(1);
    // The review's flat light-grey patch (232) is preserved below clipping.
    const levels = [-100,-50,-10,50,100].map(a => Math.round(grey(232/255,a)*255));
    expect(levels).toEqual([206,219,229,241,250]);
    expect(grey(128/255,-50)*255).toBeGreaterThan(126);
    for (const v of [.6,.8,.95]) {
      expect(grey(v,-50)).toBeLessThan(grey(v,-25));
      expect(grey(v,-25)).toBeLessThan(v);
      expect(grey(v,25)).toBeGreaterThan(v);
      expect(grey(v,25)).toBeLessThan(grey(v,50));
      expect(grey(v,100)).toBeLessThan(1);
    }
  });

  it("keeps bright saturated colours inside gamut without changing ratios", () => {
    for (const rgb of [[1,.6,.2],[.2,.5,1],[.92,.74,.55]]) {
      const out=highlightsReference([...rgb,1] as [number,number,number,number],100);
      expect(Math.max(...out.slice(0,3))).toBeLessThanOrEqual(1);
      expect(out[0]!/out[1]!).toBeCloseTo(rgb[0]!/rgb[1]!,12);
      expect(out[1]!/out[2]!).toBeCloseTo(rgb[1]!/rgb[2]!,12);
    }
  });

  it("joins protected tones smoothly at a fixed boundary for every strength", () => {
    for (const amount of [-100,-75,-25,25,100]) {
      // The positive t^1.25 curve approaches its boundary slope slowly.
      const eps=1e-10;
      expect(grey(.45,amount)).toBeCloseTo(.45,12);
      expect(Math.abs((grey(.45+eps,amount)-grey(.45,amount))/eps - 1)).toBeLessThan(.006);
    }
  });

  it("every effect uniform appears in both shader sources", () => {
    for (const name of Object.keys(HIGHLIGHTS_UNIFORM_DEFAULTS)) {
      expect(HIGHLIGHTS_FRAG_GL).toContain(name);
      expect(HIGHLIGHTS_WGSL).toContain(name);
    }
  });

  it("declares GLSL ES 3 and highp before any declarations", () => {
    const lines=HIGHLIGHTS_FRAG_GL.split('\n').filter(l=>l.trim());
    expect(lines[0]).toBe('#version 300 es');
    expect(lines[1]).toBe('precision highp float;');
    expect(lines.findIndex(l=>/^(in|out|uniform)\b/.test(l.trim()))).toBeGreaterThan(1);
  });

  it("uses the same plain-JS shader source in the GPU gate", () => {
    const text=readFileSync(new URL('./highlightsSources.ts',import.meta.url),'utf8').replace(/^export /gm,'');
    const shader=new Function(text+';return { HIGHLIGHTS_FRAG_GL, HIGHLIGHTS_WGSL, HIGHLIGHTS_UNIFORM_DEFAULTS }')();
    expect(shader.HIGHLIGHTS_FRAG_GL).toBe(HIGHLIGHTS_FRAG_GL);
    expect(shader.HIGHLIGHTS_WGSL).toBe(HIGHLIGHTS_WGSL);
    expect(shader.HIGHLIGHTS_UNIFORM_DEFAULTS).toEqual(HIGHLIGHTS_UNIFORM_DEFAULTS);
    expect(HIGHLIGHTS_FRAG_GL.startsWith('#version 300 es\nprecision highp float;')).toBe(true);
    expect(HIGHLIGHTS_WGSL).toContain('mainVertex');
    expect(HIGHLIGHTS_WGSL).toContain('mainFragment');
  });
});
