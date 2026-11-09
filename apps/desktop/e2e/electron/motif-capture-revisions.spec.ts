import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'
import { launchApp } from './helpers/driver'
import { createMotifDraft, publishMotifDraft } from './helpers/motif'

// Each capture host loads its Motif from a pinned revision snapshot. Four user
// Motifs opening hosts at once must each load their own page: before, only two
// snapshots were kept, so a third host's pin dropped one an earlier host had
// not loaded yet; that frame got a 404 page, setup found no `motif.define`, and
// the lane latched as the Motif's own failure for the session.
test('captures of four user Motifs at once each render their own page', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp({ env: { WEFTCUT_MOTIF_TUNING: 'captureHosts=4' } })
  try {
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]] as const
    const ids: string[] = []
    for (const [i, [r, g, b]] of colors.entries()) {
      const draft = await createMotifDraft(page, { name: `Revision pin ${i}`, size: [64, 64], default_duration_s: 2, props_schema: {} },
        `<!doctype html><html><body style="margin:0;background:transparent"><div style="width:64px;height:64px;background:rgb(${r},${g},${b})"></div>`
        + `<script>motif.define({ frame() {} })</script></body></html>`)
      ids.push(await publishMotifDraft(page, draft))
    }
    const hashes = await page.evaluate(async (ids) => {
      const list = await (window as any).api.backend.invoke('list_motifs') as Array<{ id: string; content_hash: string }>
      return ids.map(id => list.find(m => m.id === id)!.content_hash)
    }, ids)
    expect(hashes.every(h => /^[0-9a-f]{64}$/.test(h))).toBe(true)

    const captureAll = (tSec: number) => page.evaluate(async ({ ids, hashes, tSec }) => Promise.all(ids.map((motifId, i) =>
      (window as any).api.backend.invoke('motif_capture_frame', {
        motifId, tSec, propsJson: '{}', width: 64, height: 64, contentHash: hashes[i],
      }).then((data: Uint8Array) => ({ ok: true as const, bytes: Array.from(data) }), (e: unknown) => ({ ok: false as const, error: String(e) })),
    )), { ids, hashes, tSec })
    const center = (32 * 64 + 32) * 4
    for (const tSec of [0, 0.5]) {
      const shots = await captureAll(tSec)
      for (const [i, shot] of shots.entries()) {
        expect(shot.ok ? '' : shot.error, `Motif ${i} at ${tSec}s`).toBe('')
        if (!shot.ok) continue
        const pixels = PNG.sync.read(Buffer.from(shot.bytes)).data
        expect([...pixels.subarray(center, center + 4)], `Motif ${i} at ${tSec}s`).toEqual([...colors[i]!, 255])
      }
    }
  } finally {
    await app.close()
  }
})
