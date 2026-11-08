import { CAPTURE_HOST_FILE, FRAME_MARKER_PIXELS, FRAME_MARKER_ROWS, frameMarkerBits } from "../../../shared/motifs/frameMarker";
import { MOTIF_DEADLINES } from "../../../shared/motifs/tuning";

/** Testable core: installs clock takeover onto an arbitrary global-like object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMotifRuntime(g: any = {}) {
  let vclock = 0;
  const epoch = 1700000000000;
  let rafQ: Array<(t: number) => void> = [];
  g.performance = { now: () => vclock };
  g.Date = Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function () { return new (Date as any)(epoch + vclock); },
    { now: () => epoch + vclock },
  );
  g.requestAnimationFrame = (cb: (t: number) => void) => { rafQ.push(cb); return rafQ.length; };
  g.cancelAnimationFrame = () => {};
  g.setTimeout = () => 0;
  g.setInterval = () => 0;
  function seek(t: number) {
    vclock = t;
    if (g.document?.getAnimations) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const a of (g.document as any).getAnimations()) {
        a.pause();
        try { a.currentTime = t; } catch { /* read-only animation */ }
      }
    }
    // Flush the queued rAF callbacks up to 4 rounds to handle re-queued cbs.
    for (let i = 0; i < 4; i++) { const q = rafQ; rafQ = []; for (const cb of q) try { cb(vclock); } catch { /* cb threw */ } }
    if (g.document?.body) void (g.document.body as HTMLElement).offsetHeight;
  }
  return { global: g, seek, epoch, get now() { return vclock; } };
}

/**
 * Browser-injection source. Injected into the hidden host window with CDP
 * `Page.addScriptToEvaluateOnNewDocument`, which runs it in every frame before
 * the frame's own scripts; sourced from this string handed to main at boot via
 * `motif_register_runtime`. It plays one of two roles:
 * - In the capture host shell (`CAPTURE_HOST_FILE`, the top frame), it forwards
 *   `__motifSetup`/`__motifRender` to the framed Motif and writes the frame id
 *   into the marker row below it (`shared/motifs/frameMarker.ts`).
 * - In the Motif's own frame, it installs the clock takeover, exposes
 *   motif.define and the `__motifRender(t, props, meta)` entry point.
 *
 * String.raw template — the substitution below (createMotifRuntime.toString)
 * is resolved by TypeScript at module-evaluation time into a plain string.
 * ZERO raw backticks are present inside the body of this literal; the only
 * backtick characters are the outer delimiters. (A stray backtick anywhere
 * inside the body would close the String.raw literal early and break the esbuild parse.)
 */
export const MOTIF_RUNTIME_SOURCE: string = String.raw`
(function () {
  if (window.top === window && window.location && window.location.pathname.endsWith(${JSON.stringify('/' + CAPTURE_HOST_FILE)})) {
    var markerBits = (${frameMarkerBits.toString()});
    var motifWindow = function () { var f = document.querySelector('iframe'); return f && f.contentWindow; };
    var marker = null;
    var mark = function (id) {
      if (!marker) {
        marker = document.createElement('div');
        marker.style.cssText = 'position:fixed;left:0;bottom:0;display:flex;width:${FRAME_MARKER_PIXELS}px;height:${FRAME_MARKER_ROWS}px;pointer-events:none';
        for (var i = 0; i < ${FRAME_MARKER_PIXELS}; i++) {
          var px = document.createElement('i');
          px.style.cssText = 'display:block;flex:none;width:1px;height:${FRAME_MARKER_ROWS}px';
          marker.appendChild(px);
        }
        document.body.appendChild(marker);
      }
      var bits = markerBits(id);
      for (var j = 0; j < bits.length; j++) marker.children[j].style.background = bits[j] ? '#fff' : '#000';
    };
    window.__motifHostReady = function (motifId) {
      var w = motifWindow();
      return document.readyState === 'complete' && location.hostname === motifId && !!w &&
        typeof w.__motifRender === 'function' && w.document.readyState === 'complete';
    };
    // Main registers the runtime after the shell has loaded, then loads the
    // Motif here, so the Motif's documents start with the runtime.
    window.__motifShellLoad = function () {
      return new Promise(function (resolve, reject) {
        var f = document.querySelector('iframe');
        if (!f || !f.dataset.src) { reject(new Error('capture host shell has no Motif frame')); return; }
        f.addEventListener('load', function () { resolve(true); }, { once: true });
        f.src = f.dataset.src;
      });
    };
    window.__motifSetup = function (props, meta) { return motifWindow().__motifSetup(props, meta); };
    // Resolves once the frame's rendering step has run: rAF callbacks run in
    // it, and the task after them belongs to the next frame. Main renders its
    // next frame then, while this one is still on its way to a paint (ADR
    // 0159). Pacing only: the marker, not this wait, proves what a paint
    // shows. The timeout keeps a host that stopped producing frames from
    // holding the render.
    var committed = function () {
      return new Promise(function (resolve) {
        var timer = window.setTimeout(resolve, ${MOTIF_DEADLINES.renderStepMs});
        window.requestAnimationFrame(function () { window.setTimeout(function () { window.clearTimeout(timer); resolve(); }, 0); });
      });
    };
    // The id is written after the frame's seek with no rendering step between
    // them (only microtasks), so the commit that shows it shows that frame.
    window.__motifRender = async function (t, props, meta) {
      var done = await motifWindow().__motifRender(t, props, meta);
      if (meta && typeof meta.frameId === 'number') {
        mark(meta.frameId);
        await committed();
      }
      return done;
    };
    return;
  }

  var rt = (${createMotifRuntime.toString()})(window);
  var def = null, didSetup = false, lastPropsKey = null;
  // Decoder workers belong to one setup. They must not outlive it and mutate
  // later frames on a real clock. This is lifecycle management, not a sandbox:
  // the protocol CSP and Electron isolation confine their capabilities.
  var setupActive = false, rejectWorker = null;
  var workers = new Set();
  var NativeWorker = window.Worker;
  function retireWorkers() {
    setupActive = false;
    for (var worker of workers) worker.terminate();
    workers.clear();
    rejectWorker = null;
  }
  if (NativeWorker) {
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (!setupActive) throw new Error('motif: decoder Workers may only be created during setup()');
        if (workers.size >= 8) throw new Error('motif: setup supports at most 8 concurrent decoder Workers');
        super(url, options);
        workers.add(this);
        this.motifWorkerError = function (event) {
          if (rejectWorker) rejectWorker(new Error('motif: decoder worker failed (' + url + '): ' +
            (event.message || 'script loading, CSP or decoder initialization failed')));
        };
        this.addEventListener('error', this.motifWorkerError);
      }
      terminate() {
        this.removeEventListener('error', this.motifWorkerError);
        workers.delete(this);
        super.terminate();
      }
    };
  }
  if (window.SharedWorker) window.SharedWorker = function () {
    throw new Error('motif: SharedWorker is unsupported; use dedicated decoder Workers during setup()');
  };
  window.addEventListener('pagehide', retireWorkers);

  function makeRandom(seedKey) {
    // Minimal seeded PRNG stub (Mulberry32). seedKey is a string; hash it to seed.
    var seed = 0;
    for (var i = 0; i < seedKey.length; i++) {
      seed = (seed ^ seedKey.charCodeAt(i)) >>> 0;
      seed = ((seed >>> 16) ^ seed) * 0x45d9f3b >>> 0;
    }
    return function () {
      seed += 0x6d2b79f5;
      var t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  window.motif = {
    define: function (d) { def = d; didSetup = false; lastPropsKey = null; },
    random: makeRandom,
  };

  function ctxFor(t, props, meta) {
    return {
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      frame: Math.round(t * meta.fps),
      random: makeRandom,
    };
  }

  // Main gives initialization its own wall-clock budget, separate from frame.
  // __motifRender also calls this for standalone authoring/test compatibility.
  window.__motifSetup = async function (props, meta) {
    if (!def) throw new Error("motif: no motif.define() called");
    var propsKey = JSON.stringify(props);
    if (didSetup && propsKey === lastPropsKey) return true;
    // A frame whose color-scheme differs from its document's gets an opaque
    // backdrop, which would cover a transparent Motif.
    if (window.frameElement) window.frameElement.style.colorScheme = getComputedStyle(document.documentElement).colorScheme;
    didSetup = false;
    setupActive = true;
    var workerFailure = new Promise(function (_, reject) { rejectWorker = reject; });
    try {
      await Promise.race([
        (async function () {
          if (def.setup) await def.setup(props, ctxFor(0, props, meta));
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
        })(),
        workerFailure
      ]);
      didSetup = true; lastPropsKey = propsKey;
      return true;
    } finally { retireWorkers(); }
  };

  // Driven from the Electron main process (main/motif/captureHost.ts) via CDP
  // Runtime.evaluate(awaitPromise:true), through the capture host shell.
  // Resolves once setup (once-per-props), frame(t) and the seek to t
  // (seconds) have run; the shell's frame id proves which commit shows it.
  window.__motifRender = function (t, props, meta) {
    return (async function () {
      await window.__motifSetup(props, meta);
      if (def.frame) def.frame(t, ctxFor(t, props, meta));
      rt.seek(t * 1000);
      return true;
    })();
  };
})();
`;
