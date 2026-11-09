import { test, expect, type Page } from '@playwright/test';
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from './helpers/driver';
import { createMotifDraft, publishMotifDraft } from './helpers/motif';

/// A paused seek onto a Motif that has nothing to show yet keeps the last
/// picture, as a first visit to a video clip does, rather than presenting the
/// black canvas beneath it (`CompositionNode` §canPresentClipsAt,
/// `MotifPlaybackCursor.holdDeadline`).

const PINK_MOTIF = `<!doctype html><html><body style="margin:0;background:transparent">
  <canvas id="c" width="640" height="360"></canvas><script>
  motif.define({frame(){ const c=document.getElementById('c').getContext('2d');
    c.fillStyle='#e02080'; c.fillRect(0,0,640,360); }});
  </script></body></html>`;

/// A host's first frame waits about 1.5 s for setup, longer than a visit in
/// the second test lasts. A Worker's timer runs in real time; the page's own
/// timers follow the Motif clock.
const SLOW_SETUP_MOTIF = `<!doctype html><html><body style="margin:0;background:transparent">
  <canvas id="c" width="640" height="360"></canvas><script>
  motif.define({
    async setup(){
      const url = URL.createObjectURL(new Blob(['setTimeout(() => postMessage(1), 1500)'], {type:'text/javascript'}));
      try { await new Promise(resolve => { new Worker(url).onmessage = resolve; }); } finally { URL.revokeObjectURL(url); }
    },
    frame(){ const c=document.getElementById('c').getContext('2d');
      c.fillStyle='#e02080'; c.fillRect(0,0,640,360); }});
  </script></body></html>`;

interface Sample { r: number; g: number; b: number; a: number }
const sample = (page: Page) => page.evaluate(() => (window as any).__weftcutTest.weftcutSampleComposite(320, 180)) as Promise<Sample>;
const isRed = (p: Sample) => p.r > 200 && p.g < 40 && p.b < 40;
const isPink = (p: Sample) => p.r > 180 && p.g < 80 && p.b > 90;
const seek = (page: Page, us: number) => page.evaluate(us => (window as any).__weftcutTest.weftcutSeekUs(us), us);

test('a seek onto a Motif with no frame yet keeps the last picture, then shows the Motif', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-motif-hold-'), name: 'Hold',
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } });
    // Nothing may capture the Motif before the seek reaches it.
    await invokeCmd(page, 'app_settings_set', { patch: { prebake_motifs: false } });
    await waitForHook(page, 'weftcutSampleComposite');
    await invokeCmd<string>(page, 'add_color_layer', { tStartUs: 0, durationUs: 3_000_000, color: { r: 255, g: 0, b: 0, a: 255 } });
    const motifId = await publishMotifDraft(page, await createMotifDraft(page, {
      id: 'hold-pink', name: 'Hold pink', version: 1, size: [640, 360], default_duration_s: 2, props_schema: {},
    }, PINK_MOTIF));
    // Alone on its track, past the lookahead window from the red picture.
    await invokeCmd<string>(page, 'add_motif', { motifId, tStartUs: 3_000_000, tEndUs: 5_000_000 });
    // The preview mounts once the composition has a layer.
    await expect.poll(async () => {
      try { await seek(page, 1_000_000); return isRed(await sample(page)); } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);

    await seek(page, 3_200_000);
    // Inside the hold (its limit is 500 ms): the red picture or the Motif,
    // never the empty canvas.
    const seen: string[] = [];
    const started = Date.now();
    while (Date.now() - started < 300) {
      const p = await sample(page);
      seen.push(isRed(p) ? 'red' : isPink(p) ? 'pink' : `other ${p.r},${p.g},${p.b},${p.a}`);
    }
    expect(seen.filter(s => s.startsWith('other')), `samples after the seek: ${seen.join(' | ')}`).toEqual([]);
    await expect.poll(async () => isPink(await sample(page)), { timeout: 15_000 }).toBe(true);
  } finally { await app.close(); }
});

test('a Motif left before its frame landed holds again when the playhead returns', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-motif-hold-return-'), name: 'Hold return',
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } });
    await invokeCmd(page, 'app_settings_set', { patch: { prebake_motifs: false } });
    await waitForHook(page, 'weftcutSampleComposite');
    await invokeCmd<string>(page, 'add_color_layer', { tStartUs: 0, durationUs: 3_000_000, color: { r: 255, g: 0, b: 0, a: 255 } });
    const motifId = await publishMotifDraft(page, await createMotifDraft(page, {
      id: 'hold-slow', name: 'Hold slow', version: 1, size: [640, 360], default_duration_s: 5, props_schema: {},
    }, SLOW_SETUP_MOTIF));
    await invokeCmd<string>(page, 'add_motif', { motifId, tStartUs: 3_000_000, tEndUs: 8_000_000 });
    await expect.poll(async () => {
      try { await seek(page, 1_000_000); return isRed(await sample(page)); } catch { return false; }
    }, { timeout: 15_000 }).toBe(true);

    // A visit too short for its first frame, then back to red for longer than
    // a hold used to last, then onto an earlier frame of the same Motif.
    await seek(page, 6_500_000);
    await new Promise(resolve => setTimeout(resolve, 40));
    await seek(page, 1_000_000);
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(isRed(await sample(page))).toBe(true);
    await seek(page, 3_300_000);
    const seen: string[] = [];
    const started = Date.now();
    while (Date.now() - started < 400) {
      const p = await sample(page);
      seen.push(isRed(p) ? 'red' : isPink(p) ? 'pink' : `other ${p.r},${p.g},${p.b},${p.a}`);
    }
    expect(seen.filter(s => s.startsWith('other')), `samples after the return: ${seen.join(' | ')}`).toEqual([]);
    await expect.poll(async () => isPink(await sample(page)), { timeout: 15_000 }).toBe(true);
  } finally { await app.close(); }
});
