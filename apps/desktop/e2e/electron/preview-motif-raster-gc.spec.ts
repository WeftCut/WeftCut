// e2e gate: the L2 raster GC (`hydrateBakedIndexAndGc` → `gcUnreferenced`)
// must NEVER delete on-disk motif frames while a motif layer is unresolvable
// (catalog sync lost the race with project open / transient list_motifs
// failure / draft temporarily missing) — "can't resolve" is not "orphaned".
// Deleting on a guess is unrecoverable: a full re-bake costs tens of minutes
// of serial capture time. The control half pins the other side: with every
// motif resolvable, a genuinely unreferenced hash dir IS reclaimed.

import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, newProject, waitForHook, tmpDir } from './helpers/driver'

const MOTIF_ID = 'e2e-raster-gc-motif'

function motifHtml(): string {
  const manifest = {
    id: MOTIF_ID,
    name: 'E2E Raster GC Motif',
    version: 1,
    size: [320, 320],
    default_duration_s: 4,
    props_schema: {},
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<script type="application/json" id="motif-manifest">${JSON.stringify(manifest)}</script>` +
    `<style>html,body{margin:0;background:transparent}#box{width:320px;height:320px;background:#8866cc}</style>` +
    `</head><body><div id="box"></div>` +
    `<script>motif.define({ setup() {} });</script>` +
    `</body></html>`
  )
}

function invoke(page: import('@playwright/test').Page, channel: string, args: unknown) {
  return page.evaluate(
    ([c, a]) => (window as any).api.backend.invoke(c, a),
    [channel, args] as const,
  )
}

async function reopen(page: import('@playwright/test').Page, projectPath: string): Promise<void> {
  const r = await page.evaluate(
    (p) =>
      (window as any).__weftcutTest
        .motifReopenProject({ path: p })
        .then(() => ({ ok: true }))
        .catch((e: unknown) => ({ ok: false, error: String(e) })),
    projectPath,
  )
  if (!r.ok) throw new Error('motifReopenProject failed: ' + r.error)
}

test('@serial raster GC keeps frames when a motif is unresolvable, reclaims true orphans', async () => {
  test.setTimeout(180_000)
  const userData = tmpDir('weftcut-e2e-raster-gc-userdata-')
  const motifsRoot = path.join(userData, 'data', 'motifs')
  const { app, page } = await launchApp({ userDataDir: userData })
  try {
    // The user Motif exists on disk BEFORE the project references it.
    mkdirSync(path.join(motifsRoot, MOTIF_ID), { recursive: true })
    writeFileSync(path.join(motifsRoot, MOTIF_ID, 'index.html'), motifHtml())

    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-raster-gc-proj-'),
      name: 'raster-gc',
      canvas: { width: 320, height: 320, fpsNum: 30, fpsDen: 1 },
    })
    await waitForHook(page, 'addMotifLayer')
    await waitForHook(page, 'motifReopenProject')
    const projectPath = (await invoke(page, 'workspace_dir', {})) as string

    // Wait until the catalog can resolve the draft, then place a layer of it.
    await expect
      .poll(async () =>
        ((await invoke(page, 'list_motifs', {})) as Array<{ id: string }>).some((m) => m.id === MOTIF_ID),
      )
      .toBe(true)
    const added = await page.evaluate(
      (id) =>
        (window as any).__weftcutTest
          .addMotifLayer({ motifId: id, durationUs: 2_000_000 })
          .then((layerId: string) => ({ ok: true, layerId }))
          .catch((e: unknown) => ({ ok: false, error: String(e) })),
      MOTIF_ID,
    )
    if (!added.ok) throw new Error('addMotifLayer failed: ' + added.error)

    const orphanDir = path.join(projectPath, 'Cache', 'raster', 'deadbeef')
    const seedOrphan = () => {
      mkdirSync(orphanDir, { recursive: true })
      writeFileSync(path.join(orphanDir, '0.png'), Buffer.from('x'))
    }

    // Control: every motif resolvable → a hash dir no live key references IS
    // reclaimed. Poll: hydrate + GC are fire-and-forget after the open.
    seedOrphan()
    await reopen(page, projectPath)
    await expect.poll(() => existsSync(orphanDir), { timeout: 15_000 }).toBe(false)

    // The motif becomes UNRESOLVABLE (draft deleted from the data root —
    // models any transient catalog gap at open). Reopen: GC must skip, and
    // even a dir it would otherwise collect must survive.
    rmSync(path.join(motifsRoot, MOTIF_ID), { recursive: true, force: true })
    seedOrphan()
    await reopen(page, projectPath)
    // Give the fire-and-forget hydrate ample time to (not) run its GC, on a
    // loaded runner included. Existence after a window that covers it is the
    // assertion — there is nothing to poll toward.
    await page.waitForTimeout(8_000)
    expect(
      existsSync(orphanDir),
      'GC deleted raster frames while a motif layer was unresolvable',
    ).toBe(true)
  } finally {
    await app.close()
  }
})
