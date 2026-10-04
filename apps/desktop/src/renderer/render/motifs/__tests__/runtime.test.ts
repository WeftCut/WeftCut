import { describe, it, expect, vi } from "vitest";
import { createMotifRuntime, MOTIF_RUNTIME_SOURCE } from "../runtime";
import { runInNewContext } from 'node:vm';

function pageRuntime() {
  const workers: Array<EventTarget & { terminate: ReturnType<typeof vi.fn> }> = [];
  class Worker extends EventTarget {
    terminate = vi.fn();
    constructor(public url: string) { super(); workers.push(this); }
  }
  const document = { fonts: { ready: Promise.resolve() }, getAnimations: () => [], body: {} };
  const window: any = { Worker, SharedWorker: Worker, document, addEventListener: vi.fn(),
    requestAnimationFrame: (cb: () => void) => queueMicrotask(cb) };
  runInNewContext(MOTIF_RUNTIME_SOURCE, { window, document, console });
  return { window, workers };
}

describe('Motif setup decoder workers', () => {
  it('awaits setup, retires its workers before frame, and rebuilds only on props changes', async () => {
    const { window, workers } = pageRuntime();
    let ready!: () => void;
    const setup = vi.fn(async () => {
      new window.Worker('blob:decoder');
      await new Promise<void>(resolve => { ready = resolve; });
    });
    const frame = vi.fn();
    window.motif.define({ setup, frame });
    const first = window.__motifRender(0, {}, { settleRafs: 0 });
    expect(frame).not.toHaveBeenCalled();
    ready(); await first;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    await window.__motifRender(1, {}, { settleRafs: 0 });
    await window.__motifRender(0, {}, { settleRafs: 0 });
    expect(setup).toHaveBeenCalledOnce();
    expect(() => new window.Worker('blob:late')).toThrow(/setup/);
    const changed = window.__motifRender(0, { scale: 2 }, { settleRafs: 0 });
    ready(); await changed;
    expect(setup).toHaveBeenCalledTimes(2);
    expect(workers[1]!.terminate).toHaveBeenCalledOnce();
  });

  it('a worker load error rejects a waiting setup and retires all workers', async () => {
    const { window, workers } = pageRuntime();
    window.motif.define({ setup: () => { new window.Worker('./missing.js'); return new Promise(() => {}); } });
    const failure = expect(window.__motifRender(0, {}, {})).rejects.toThrow(/decoder worker.*missing.js/i);
    workers[0]!.dispatchEvent(new Event('error'));
    await failure;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });

  it('rejects an oversized decoder pool and cleans up the workers it already created', async () => {
    const { window, workers } = pageRuntime();
    window.motif.define({ setup() { for (let i = 0; i < 9; i++) new window.Worker('blob:decoder'); } });
    await expect(window.__motifSetup({}, {})).rejects.toThrow(/at most 8/);
    expect(workers).toHaveLength(8);
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('a throwing setup releases its workers and cannot start workers from frame', async () => {
    const { window, workers } = pageRuntime();
    window.motif.define({ setup() { new window.Worker('blob:decoder'); throw new Error('bad model'); } });
    await expect(window.__motifRender(0, {}, {})).rejects.toThrow('bad model');
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    window.motif.define({ frame() { new window.Worker('blob:animation'); } });
    await expect(window.__motifRender(0, {}, {})).rejects.toThrow(/setup/);
    expect(() => new window.SharedWorker('./persistent.js')).toThrow(/SharedWorker/);
  });
});

describe("MOTIF_RUNTIME_SOURCE settle", () => {
  it("contains a meta.settleRafs read (branch behavior verified in real Chromium/Electron)", () => {
    // The render entry must consult meta.settleRafs to choose the settle depth.
    // The browser's actual paint barrier is exercised in Electron.
    expect(MOTIF_RUNTIME_SOURCE).toContain("meta.settleRafs");
  });
});

describe("motif runtime seek", () => {
  it("freezes rAF until seek flushes it, at the virtual clock", () => {
    const rt = createMotifRuntime();
    const seen: number[] = [];
    rt.global.requestAnimationFrame((t: number) => seen.push(t));
    expect(seen).toEqual([]);            // not auto-run
    rt.seek(500);
    expect(seen).toEqual([500]);          // flushed at virtual clock
    expect(rt.global.performance.now()).toBe(500);
  });
  it("re-seeking the same t is idempotent for time reads", () => {
    const rt = createMotifRuntime();
    rt.seek(500); rt.seek(1000); rt.seek(500);
    expect(rt.global.performance.now()).toBe(500);
    expect(rt.global.Date.now()).toBe(rt.epoch + 500);
  });
  it("setInterval/setTimeout are neutralized", () => {
    const rt = createMotifRuntime();
    const spy = vi.fn();
    rt.global.setInterval(spy, 1); rt.global.setTimeout(spy, 1);
    rt.seek(5000);
    expect(spy).not.toHaveBeenCalled();
  });
});
