import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { launchApp, newProject, tmpDir, invokeCmd } from './helpers/driver';
import { createMotifDraft, publishMotifDraft } from './helpers/motif';

/// Real-app checks that a capture timeout is probation, not a verdict
/// (docs/motifs.md#capture-host),
/// on this machine's capture backend.
///
/// The first test is deterministic and runs everywhere: a Motif that hangs on
/// demand drives the host through strike, probation retry, verdict and the
/// fast-reject, and shows another lane is unaffected.
///
/// The second is a measurement under CPU load and runs only with
/// `WEFTCUT_E2E_LOAD=1`: it reports capture times idle vs loaded, then pushes a
/// calibrated CPU-bound frame over the deadline under load and checks the lane
/// recovers once the load is gone — the case the old latch lost for a session.

interface Probe { ok: boolean; ms: number; error?: string; opaque?: boolean; width?: number; height?: number }
type Capture = Record<string, unknown>;

async function installProbePort(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__probe) return;
    const channel = new MessageChannel();
    const pending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>();
    channel.port1.onmessage = ({ data }) => {
      const request = pending.get(data.id); if (!request) { data.bitmap?.close(); return; }
      pending.delete(data.id);
      if (data.error || !data.bitmap) request.reject(new Error(data.error ?? 'Missing capture'));
      else request.resolve(data.bitmap);
    };
    window.postMessage({ type: 'weftcut:motif-frame-port' }, '*', [channel.port2]);
    let next = 0;
    const context = new OffscreenCanvas(3, 1).getContext('2d', { willReadFrequently: true })!;
    w.__probe = async (capture: Record<string, unknown>) => {
      const id = ++next; const started = performance.now();
      try {
        const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          channel.port1.postMessage({ id, capture: { ...capture, coalesceKey: `probe:${id}`, high: true } });
        });
        try {
          context.clearRect(0, 0, 3, 1);
          context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, 3, 1);
          const px = context.getImageData(0, 0, 3, 1).data;
          return { ok: true, ms: performance.now() - started, width: bitmap.width, height: bitmap.height,
            opaque: [3, 7, 11].every(i => px[i]! >= 250) };
        } finally { bitmap.close(); }
      } catch (error) {
        return { ok: false, ms: performance.now() - started, error: String(error) };
      }
    };
  });
}

const probe = (page: Page, capture: Capture): Promise<Probe> => page.evaluate(c => (window as any).__probe(c), capture);
interface Diagnostics {
  captures: number; completed: number; failed: number; hostBuilds: number; pageLoads: number;
  textureCaptures: number; pngCaptures: number;
}
const diagnostics = (page: Page) => invokeCmd<Diagnostics>(page, 'motif_capture_diagnostics');
/// Which backend the host actually used: shared textures where the platform
/// offers them (Windows OSR), PNG elsewhere or after a fallback.
const backend = async (page: Page) => {
  const d = await diagnostics(page);
  return `backend: ${d.textureCaptures} texture / ${d.pngCaptures} png captures, ${d.hostBuilds} host builds, ${d.failed} failed`;
};
const isTimeout = (r: Probe) => !r.ok && /timed out/.test(r.error ?? '');

async function publish(page: Page, id: string, html: string): Promise<{ motifId: string; contentHash: string }> {
  const motifId = await publishMotifDraft(page, await createMotifDraft(page, {
    id, name: id, version: 1, size: [1920, 1080], default_duration_s: 20, props_schema: {},
  }, html));
  const list = await invokeCmd<Array<{ id: string; content_hash?: string }>>(page, 'list_motifs');
  const contentHash = list.find(m => m.id === motifId)?.content_hash;
  if (!contentHash) throw new Error(`no content_hash for ${motifId}`);
  return { motifId, contentHash };
}

const BASE = { width: 1920, height: 1080, settleRafs: 2, fpsNum: 25, fpsDen: 1 };
const request = (m: { motifId: string; contentHash: string }, tSec: number, props: Record<string, unknown>): Capture =>
  ({ ...BASE, ...m, tSec, propsJson: JSON.stringify(props) });

/// A solid canvas that hangs its frame when asked (`hang`) or burns a given
/// number of iterations first (`spin`) — the Motif's own clock is virtual, so
/// cost is expressed in work, not time.
const SOLID_HTML = `<!doctype html><html><body style="margin:0;background:transparent">
  <canvas id="c" width="1920" height="1080"></canvas><script>
  motif.define({setup(props){ window.__props = props; }, frame(t, ctx){
    const p = window.__props || {};
    if (p.hang) { for (;;) {} }
    let acc = 0; for (let i = 0; i < (p.spin || 0); i++) acc += Math.sqrt(i);
    const c=document.getElementById('c').getContext('2d');
    c.fillStyle='#e02080';c.fillRect(0,0,1920,1080);
    c.fillStyle='#e02080';c.fillRect(0,0,1,acc>=0?1:0);
  }});
  </script></body></html>`;

const NETWORK_PROPS = {
  accent: '#D2261C', count: 70, cue_detail_s: 11.4, cue_link_s: 3.6, cue_pattern_s: 14.8, cue_release_s: 12.2,
  cue_signal_s: 10.9, cue_spread_s: 7.2, detail: 'synapse', duration_s: 17.5, exit: 'fade', ground: 'paper',
  ink: '#16130F', kind: 'neuron', paper: '#F2ECDF', seed: 7, step_fps: 0,
};

function spawnBurners(count: number): ChildProcess[] {
  return Array.from({ length: count }, () => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
}

test.describe('Motif capture timeouts on the real host', () => {
  test.setTimeout(300_000);

  test('a hung frame is probation: one real retry on the rebuilt host, then a verdict that spares other lanes', async () => {
    // The platform's default backend: shared textures on Windows, PNG elsewhere.
    const { app, page } = await launchApp({});
    try {
      await newProject(page, { parentFolder: tmpDir('weftcut-capture-hang-'), name: 'Hang',
        canvas: { width: 1920, height: 1080, fpsNum: 25, fpsDen: 1 } });
      const solid = await publish(page, 'hang-solid', SOLID_HTML);
      const network = await publish(page, 'hang-network', readFileSync(new URL('./fixtures/png-capture-network.html', import.meta.url), 'utf8'));
      await installProbePort(page);
      const log = (s: string) => console.log('[capture-hang] ' + s);

      const warm = await probe(page, request(solid, 0, { hang: false }));
      expect(warm.ok, warm.error).toBe(true);
      log(`warm ${warm.ms.toFixed(0)} ms`);

      const strike1 = await probe(page, request(solid, 0.04, { hang: true }));
      log(`strike 1: ${strike1.ms.toFixed(0)} ms ${strike1.error ?? ''}`);
      expect(isTimeout(strike1)).toBe(true);
      expect(strike1.ms).toBeGreaterThan(4500);

      const before = await diagnostics(page);
      const retry = await probe(page, request(solid, 0.08, { hang: false }));
      log(`probation retry: ok=${retry.ok} ${retry.ms.toFixed(0)} ms ${retry.error ?? ''}`);
      expect(retry.ok, 'the lane gets one real retry on the rebuilt host').toBe(true);
      expect(retry.opaque).toBe(true);
      expect((await diagnostics(page)).hostBuilds, 'the hung host was rebuilt').toBe(before.hostBuilds + 1);

      const strike2 = await probe(page, request(solid, 0.12, { hang: true }));
      const strike3 = await probe(page, request(solid, 0.16, { hang: true }));
      log(`strikes 2+3: ${strike2.ms.toFixed(0)} / ${strike3.ms.toFixed(0)} ms`);
      expect(isTimeout(strike2) && strike2.ms > 4500).toBe(true);
      expect(isTimeout(strike3) && strike3.ms > 4500, 'the second strike is still a real attempt').toBe(true);

      const latched = await diagnostics(page);
      const verdict = await probe(page, request(solid, 0.2, { hang: false }));
      log(`after two consecutive timeouts: ok=${verdict.ok} ${verdict.ms.toFixed(0)} ms`);
      expect(isTimeout(verdict)).toBe(true);
      expect(verdict.ms, 'a latched lane fast-rejects without reaching the page').toBeLessThan(1000);
      expect((await diagnostics(page)).captures, 'a fast-reject is not a capture').toBe(latched.captures);

      const other = await probe(page, request(network, 2, NETWORK_PROPS));
      log(`other lane after the verdict: ok=${other.ok} ${other.ms.toFixed(0)} ms`);
      expect(other.ok, other.error).toBe(true);
      log(await backend(page));
    } finally { await app.close(); }
  });
});

test.describe('Motif capture under CPU load', () => {
  test.skip(!process.env.WEFTCUT_E2E_LOAD, 'measurement; set WEFTCUT_E2E_LOAD=1');
  test.setTimeout(900_000);

  test('a slow-but-healthy lane that crosses the deadline under load recovers when the load lifts', async () => {
    const { app, page } = await launchApp({});
    let burners: ChildProcess[] = [];
    const stopLoad = () => { for (const b of burners) b.kill('SIGKILL'); burners = []; };
    try {
      await newProject(page, { parentFolder: tmpDir('weftcut-capture-load-'), name: 'Load',
        canvas: { width: 1920, height: 1080, fpsNum: 25, fpsDen: 1 } });
      const solid = await publish(page, 'load-solid', SOLID_HTML);
      const network = await publish(page, 'load-network', readFileSync(new URL('./fixtures/png-capture-network.html', import.meta.url), 'utf8'));
      await installProbePort(page);
      const log = (s: string) => console.log('[capture-load] ' + s);
      const cores = os.cpus().length;

      // ---- Heavy authored page: idle vs loaded, every frame must arrive ----
      const frames = 16;
      const sweep = async (label: string) => {
        const results: Probe[] = [];
        for (let i = 0; i < frames; i++) results.push(await probe(page, request(network, 2 + i / 25, NETWORK_PROPS)));
        const ms = results.filter(r => r.ok).map(r => r.ms).sort((a, b) => a - b);
        log(`${label}: ${ms.length}/${frames} ok, median ${ms[ms.length >> 1]?.toFixed(0)} ms, p90 ${ms[Math.floor(ms.length * 0.9)]?.toFixed(0)} ms, max ${ms.at(-1)?.toFixed(0)} ms`);
        results.forEach((r, i) => { if (!r.ok) log(`  ${label} frame ${i}: ${r.ms.toFixed(0)} ms ${r.error}`); });
        return results;
      };
      await sweep('idle');
      burners = spawnBurners(cores);
      log(`${cores} burners on ${cores} cores`);
      const loaded = await sweep(`loaded x1`);
      stopLoad();
      // Under load a healthy lane may time out, but it may only fast-reject
      // after two consecutive real timeouts; anything else is a lost frame.
      let consecutive = 0;
      for (const r of loaded) {
        if (r.ok) { consecutive = 0; continue; }
        if (isTimeout(r) && r.ms > 4500) { consecutive++; continue; }
        expect(consecutive, `fast rejection without two consecutive timeouts: ${r.error}`).toBeGreaterThanOrEqual(2);
      }

      // ---- Calibrated CPU-bound frame: over the deadline only under load ----
      // Aim at 2-3 s idle: inside the 5 s deadline alone, past it once the
      // renderer is down to a fraction of a core. Work-per-second is not
      // stable enough for one linear extrapolation (JIT tiering, turbo and
      // core migration moved it 1.6x on a 13th-gen Windows host), so grow the
      // spin by 1.5x per measured step until a frame takes 2 s or more.
      const base = await probe(page, request(solid, 0.04, { spin: 0 }));
      expect(base.ok, base.error).toBe(true);
      let spin = 2e8, tSpin = 0.08, measured = await probe(page, request(solid, tSpin, { spin }));
      while (measured.ok && measured.ms - base.ms < 400) { spin *= 4; tSpin += 0.04; measured = await probe(page, request(solid, tSpin, { spin })); }
      for (let step = 0; measured.ok && measured.ms < 2000 && step < 10; step++) {
        spin = Math.round(spin * 1.5); tSpin += 0.04;
        measured = await probe(page, request(solid, tSpin, { spin }));
        log(`calibration step ${step}: spin=${spin} → ${measured.ms.toFixed(0)} ms ${measured.error ?? ''}`);
      }
      log(`calibration: base ${base.ms.toFixed(0)} ms, spin=${spin} → idle ${measured.ms.toFixed(0)} ms ok=${measured.ok} ${measured.error ?? ''}`);
      // An idle timeout means this host's work rate drifted past what the
      // steps can bracket; the lane is on probation and the measurement is
      // not meaningful here, so say so instead of failing.
      test.skip(!measured.ok, `could not calibrate a 2-5 s frame idle on this host: ${measured.error}`);

      burners = spawnBurners(cores * 4);
      log(`${cores * 4} burners on ${cores} cores`);
      const slow = await probe(page, request(solid, tSpin + 0.04, { spin }));
      log(`spin loaded: ok=${slow.ok} ${slow.ms.toFixed(0)} ms ${slow.error ?? ''}`);
      stopLoad();
      if (slow.ok) {
        log('the machine absorbed 4x oversubscription without crossing the 5 s deadline; the recovery branch was not exercised');
      } else {
        expect(isTimeout(slow), slow.error).toBe(true);
        // The same lane, the load gone: the old latch would fast-reject this
        // for the rest of the session. Probation lets the rebuilt host render it.
        const recovered = await probe(page, request(solid, tSpin + 0.08, { spin }));
        log(`spin after load: ok=${recovered.ok} ${recovered.ms.toFixed(0)} ms ${recovered.error ?? ''}`);
        expect(recovered.ok, 'a healthy lane recovers after a load-induced timeout').toBe(true);
        expect(recovered.ms).toBeGreaterThan(1000); // a real render, not a cached verdict
      }
      log(await backend(page));
    } finally {
      stopLoad();
      await app.close();
    }
  });
});
