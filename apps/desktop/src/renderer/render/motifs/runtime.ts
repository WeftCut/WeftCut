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
 * `Page.addScriptToEvaluateOnNewDocument` (runs before the Motif's own
 * scripts), sourced from this string handed to main at boot via
 * `motif_register_runtime`. Installs the runtime on window, exposes
 * motif.define, and a window.__motifRender(t, props, meta) entry point that
 * main drives over CDP Runtime.evaluate(awaitPromise:true).
 *
 * String.raw template — the substitution below (createMotifRuntime.toString)
 * is resolved by TypeScript at module-evaluation time into a plain string.
 * ZERO raw backticks are present inside the body of this literal; the only
 * backtick characters are the outer delimiters. (A stray backtick anywhere
 * inside the body would close the String.raw literal early and break the esbuild parse.)
 */
export const MOTIF_RUNTIME_SOURCE: string = String.raw`
(function () {
  // Capture the NATIVE requestAnimationFrame BEFORE the factory overwrites it.
  // The factory installs a queued rAF (only fires on rt.seek) onto window.rAF.
  // The settle await inside __motifRender uses _nativeRaf so the Promise actually
  // resolves after two real browser layout frames. Using the overwritten queued
  // rAF would deadlock every render because seek() is never called during settle.
  var _nativeRaf = window.requestAnimationFrame.bind(window);
  // Browser paint barrier; unlike the virtual clock this never advances t.
  window.__motifPaintReady = function () {
    return new Promise(function (resolve) { _nativeRaf(function () { _nativeRaf(resolve); }); });
  };

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

  // Driven from the Electron main process (main/motif/capture.ts) via CDP
  // Runtime.evaluate(awaitPromise:true).
  // Resolves once setup (once-per-props) + frame(t) + seek + a double-rAF settle
  // have run, i.e. the frame for time t (seconds) is visually ready to capture.
  window.__motifRender = function (t, props, meta) {
    return (async function () {
      await window.__motifSetup(props, meta);
      if (def.frame) def.frame(t, ctxFor(t, props, meta));
      rt.seek(t * 1000);
      // settleRafs: how many real browser frames to wait so the paint commits.
      // 2 (default) is safe for canvas/WebGL; 1 suffices for CSS-only Motifs;
      // 0 captures immediately after seek(). Clamp to {0,1,2}; default 2.
      var sr = meta && typeof meta.settleRafs === 'number' ? meta.settleRafs : 2;
      sr = sr === 2 ? 2 : (sr === 1 ? 1 : (sr === 0 ? 0 : 2));
      if (sr === 2) {
        await new Promise(function (r) { _nativeRaf(function () { _nativeRaf(r); }); });
      } else if (sr === 1) {
        await new Promise(function (r) { _nativeRaf(r); });
      }
      return true;
    })();
  };
})();
`;
