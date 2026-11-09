import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { invokeCmd, launchApp } from './helpers/driver'

/// Content versions of one Motif share its capture window: each new version
/// loads in the window's frame (docs/motifs.md#capture-host). One capture host
/// in all, so every version switches that window, and no project is open, so
/// nothing else (library covers, previews) captures. The Motif draws
/// only into a canvas over a transparent page, so the first frame of every
/// version must show that version's canvas, with real alpha beside it: a
/// document whose canvases were missing, or the previous version still in the
/// frame, would read transparent or the wrong colour.

const VERSIONS = 8
const W = 1280, H = 720
const COLORS = [[224, 32, 128], [32, 160, 64], [40, 80, 224], [240, 200, 16]] as const

/// Version `v`: the left half filled with its colour, the right half left
/// transparent.
const page = (v: number) => {
  const [r, g, b] = COLORS[v % COLORS.length]!
  return `<!doctype html><html><body style="margin:0;background:transparent">
  <canvas id="c" width="${W}" height="${H}"></canvas><script>/*v${v}*/
  motif.define({frame(){ const c=document.getElementById('c').getContext('2d');
    c.clearRect(0,0,${W},${H}); c.fillStyle='rgb(${r},${g},${b})'; c.fillRect(0,0,${W / 2},${H}); }});
  </script></body></html>`
}

/// Writes version `v` into the draft; its content hash.
async function writeVersion(p: Page, motifId: string, v: number): Promise<string> {
  return p.evaluate(async ({ motifId, html, manifest }) => {
    const invoke = (window as any).api.backend.invoke
    const info = await invoke('read_motif', { motif_id: motifId })
    await invoke('update_motif_files', { motif_id: motifId, expected_revision: info.revision,
      files: [{ path: 'manifest.json', text: JSON.stringify(manifest) }, { path: 'index.html', text: html }] })
    return (await invoke('read_motif', { motif_id: motifId })).revision as string
  }, { motifId, html: page(v), manifest: { name: 'Versioned canvas', size: [W, H], default_duration_s: 4, props_schema: {} } })
}

for (const backend of ['default', 'bitmap'] as const) {
  test(`each content version of a Motif renders in its window with its own canvas (${backend} host)`, async () => {
    test.setTimeout(240_000)
    // `default`: shared textures where the platform has them, else bitmaps.
    const { app, page: p } = await launchApp({ env: {
      WEFTCUT_MOTIF_TUNING: 'captureHosts=1',
      ...(backend === 'bitmap' ? { WEFTCUT_MOTIF_CAPTURE: 'bitmap' } : {}),
    } })
    try {
      const motifId = await p.evaluate(async () => {
        const draft = await (window as any).api.backend.invoke('open_motif_draft', { source: { kind: 'empty', name: 'Versioned canvas' } })
        return draft.motif_id as string
      })
      await invokeCmd(p, 'motif_capture_diagnostics', { reset: true })
      const wrong: string[] = []
      for (let v = 0; v < VERSIONS; v++) {
        const contentHash = await writeVersion(p, motifId, v)
        const bytes = await p.evaluate(async a => Array.from(await (window as any).api.backend.invoke('motif_capture_frame', a) as Uint8Array),
          { motifId, contentHash, tSec: 0, propsJson: '{}', width: W, height: H, fpsNum: 25, fpsDen: 1 })
        const png = PNG.sync.read(Buffer.from(bytes))
        const at = (x: number, y: number) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)]
        const left = at(W / 4, H / 2), right = at((3 * W) / 4, H / 2)
        const want = [...COLORS[v % COLORS.length]!, 255]
        if (left.join() !== want.join() || right[3] !== 0) wrong.push(`version ${v}: left ${left} (want ${want}), right alpha ${right[3]}`)
      }
      const d = await invokeCmd<{ captures: number; hostBuilds: number; hostSwaps: number; skippedFrames: number }>(p, 'motif_capture_diagnostics')
      console.log(`[versions:${backend}] ${d.captures} captures, ${d.hostBuilds} host builds, ${d.hostSwaps} swaps, ${d.skippedFrames} skipped`)
      expect(wrong, 'the first frame of every version shows its own canvas over real alpha').toEqual([])
      expect(d.captures, 'only the test captured').toBe(VERSIONS)
      expect(d.hostBuilds, 'the versions share one window').toBe(1)
      expect(d.hostSwaps).toBe(VERSIONS - 1)
    } finally { await app.close() }
  })
}
