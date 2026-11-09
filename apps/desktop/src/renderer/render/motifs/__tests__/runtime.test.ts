import { describe, it, expect, vi } from "vitest";
import { createMotifRuntime, MOTIF_RUNTIME_SOURCE } from "../runtime";
import { runInNewContext } from 'node:vm';
import { CAPTURE_HOST_FILE, decodeFrameMarker, FRAME_MARKER_PIXELS } from "../../../../shared/motifs/frameMarker";

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
    const first = window.__motifRender(0, {}, {});
    expect(frame).not.toHaveBeenCalled();
    ready(); await first;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    await window.__motifRender(1, {}, {});
    await window.__motifRender(0, {}, {});
    expect(setup).toHaveBeenCalledOnce();
    expect(() => new window.Worker('blob:late')).toThrow(/setup/);
    const changed = window.__motifRender(0, { scale: 2 }, {});
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

/// The capture host shell: a top frame at CAPTURE_HOST_FILE framing a Motif
/// page that already runs the runtime in its own role.
function hostRuntime(pathname = '/' + CAPTURE_HOST_FILE) {
  const motif = pageRuntime().window;
  motif.document.readyState = 'complete';
  // A canvas records its fills per pixel column, for the witness.
  const el = (tag?: string) => {
    const node: any = { style: {} as Record<string, string>, children: [] as any[], appendChild(c: unknown) { this.children.push(c); } };
    if (tag === 'canvas') {
      node.columns = [] as string[];
      node.getContext = () => ({ fillStyle: '', fillRect(x: number) { node.columns[x] = this.fillStyle; } });
    }
    return node;
  };
  const body = el();
  const document = { readyState: 'complete', body, createElement: el, querySelector: () => ({ contentWindow: motif }) };
  // The host's rendering steps run when the test says so.
  const rafs: Array<() => void> = [];
  const window: any = { document, location: { pathname, hostname: 'countdown' }, addEventListener: vi.fn(),
    requestAnimationFrame: (cb: () => void) => rafs.push(cb), setTimeout, clearTimeout };
  const renderStep = () => { for (const cb of rafs.splice(0)) cb(); };
  window.top = window;
  runInNewContext(MOTIF_RUNTIME_SOURCE, { window, document, location: window.location, console });
  const markerRow = () => {
    const pixels = body.children[0]?.children ?? [];
    const rgba = new Uint8Array(FRAME_MARKER_PIXELS * 4);
    pixels.forEach((px: { style: { background: string } }, i: number) => rgba.set(px.style.background === '#fff' ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4));
    return pixels.length ? decodeFrameMarker(rgba) : null;
  };
  /// The id's low byte as the witness canvas painted it, or null before any.
  const witness = () => {
    const columns: string[] | undefined = body.children[1]?.columns;
    return columns?.length ? columns.reduce((byte, c) => (byte << 1) | (c === '#fff' ? 1 : 0), 0) : null;
  };
  return { window, motif, markerRow, witness, renderStep };
}

describe('capture host shell', () => {
  it('forwards a frame to the Motif and marks its id only once the frame has run', async () => {
    const { window, motif, markerRow, witness, renderStep } = hostRuntime();
    let release!: () => void;
    const frame = vi.fn();
    motif.motif.define({ setup: () => new Promise<void>(resolve => { release = resolve; }), frame });
    const rendered = window.__motifRender(0.5, { a: 1 }, { frameId: 41 });
    await Promise.resolve();
    expect(markerRow()).toBeNull();
    expect(witness()).toBeNull();
    release()
    await vi.waitFor(() => expect(markerRow()).toBe(41));
    expect(witness()).toBe(41);
    expect(frame).toHaveBeenCalledWith(0.5, expect.anything());
    renderStep(); await rendered;
    const next = window.__motifRender(1, { a: 1 }, { frameId: 42 });
    await vi.waitFor(() => expect(markerRow()).toBe(42));
    expect(witness()).toBe(42);
    renderStep(); await next;
    const third = window.__motifRender(1, { a: 1 }, { frameId: 0x1ff });
    await vi.waitFor(() => expect(markerRow()).toBe(0x1ff));
    expect(witness()).toBe(0xff); // the id's low byte
    renderStep(); await third;
  });

  it('returns only after the rendering step that commits the frame, or a bounded wait', async () => {
    const { window, motif, renderStep } = hostRuntime();
    motif.motif.define({ frame() {} });
    let done = false;
    const rendered = window.__motifRender(0, {}, { frameId: 7 }).then(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(done).toBe(false);
    renderStep(); await rendered;
    // No rendering step at all: the render still returns.
    const started = performance.now();
    await window.__motifRender(0, {}, { frameId: 8 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(90);
  });

  it('loads the Motif into its frame only when asked, after the runtime is in place', async () => {
    const { window } = hostRuntime();
    const frame: any = { dataset: { src: 'index.html?v=1' }, src: '', listeners: [] as Array<() => void>,
      addEventListener(_type: string, cb: () => void) { this.listeners.push(cb); } };
    window.document.querySelector = () => frame;
    const loaded = window.__motifShellLoad();
    expect(frame.src).toBe('index.html?v=1');
    frame.listeners.forEach((cb: () => void) => cb());
    await expect(loaded).resolves.toBe(true);
    frame.dataset = {};
    await expect(window.__motifShellLoad()).rejects.toThrow(/no Motif frame/);
  });

  it('is ready only for its own Motif, and leaves other top pages in the Motif role', () => {
    const { window } = hostRuntime();
    expect(window.__motifHostReady('countdown')).toBe(true);
    expect(window.__motifHostReady('other')).toBe(false);
    expect(hostRuntime('/index.html').window.__motifHostReady).toBeUndefined();
  });

  it('a throwing Motif frame rejects without marking', async () => {
    const { window, motif, markerRow } = hostRuntime();
    motif.motif.define({ frame() { throw new Error('bad frame'); } });
    await expect(window.__motifRender(0, {}, { frameId: 1 })).rejects.toThrow('bad frame');
    expect(markerRow()).toBeNull();
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
