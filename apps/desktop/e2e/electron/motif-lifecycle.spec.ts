// e2e gate: a project Motif's lifecycle through the renderer bridge — made in
// the project's Motifs/ folder, listed in the project group, refused removal
// while a layer uses it, then removed from the project with its folder left
// on disk. An edit to the folder re-rendering the preview is the acceptance
// spec's (project-motifs.spec.ts).

import { test, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { existsSync } from 'node:fs'
import { forceCloseApp, invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'
import { createMotif } from './helpers/motif'

/// Playwright's electronApp.close() can hang (darwin window-all-closed not
/// quitting the app, a lingering handle), so bound it and then force-close. Two
/// rules, both of which the 8 s + `proc.kill()` first version broke:
///
///   - the force path goes through forceCloseApp, never a hand-rolled kill. Its
///     comment has what a leader-only kill costs on Windows; the short version
///     is that it trades this spec's bounded teardown for the WORKER's unbounded
///     one.
///   - the budget is a safety net, not the expected path. A graceful quit here
///     has been measured past 8 s on a loaded Windows runner, and every kill
///     that pre-empts one skips the app's own shutdown.
const CLOSE_BUDGET_MS = 30_000

async function closeAppRobustly(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      app.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_BUDGET_MS)
      }),
    ])
  } catch {
    // close() rejects when the process is already gone; the guard below no-ops.
  } finally {
    // Losing the race leaves the timer pending, and a pending timer holds the
    // worker's event loop open for the rest of the budget.
    if (timer) clearTimeout(timer)
  }
  if (proc?.exitCode === null) {
    console.log(`[lifecycle] close() outlived ${CLOSE_BUDGET_MS}ms — force-closing`)
    forceCloseApp(app)
  }
}

interface ProjectRow { id: string; group: string; status: string; state: string; path: string }

test('project Motif: create_motif → list → removal refused while used → delete_motif keeps the folder', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  try {
    await newProject(page, {
      parentFolder: tmpDir('weftcut-e2e-lifecycle-'),
      name: 'Lifecycle',
      canvas: { width: 320, height: 320, fpsNum: 30, fpsDen: 1 },
    })
    const manifest = { name: 'E2E Lifecycle Motif', version: 1, size: [320, 320], default_duration_s: 2, props_schema: {} }
    const html =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<style>html,body{margin:0;background:transparent}#box{width:320px;height:320px;background:#aabbcc}</style>` +
      `</head><body><div id="box"></div>` +
      `<script>motif.define({ setup() {} });</script></body></html>`
    const id = await createMotif(page, manifest, html)
    expect(id).toBe('e2e-lifecycle-motif')

    const projectRows = () => invokeCmd<ProjectRow[]>(page, 'list_motifs', { group: 'project' })
    const row = (await projectRows()).find((m) => m.id === id)
    // Made here, of a lineage the library does not hold.
    expect(row).toMatchObject({ group: 'project', status: 'ok', state: 'project_only' })
    expect(existsSync(row!.path)).toBe(true)

    // A layer names it: the project cannot drop it.
    await invokeCmd(page, 'add_motif', { motifId: id, tStartUs: 0 })
    await expect(invokeCmd(page, 'delete_motif', { motif_id: id })).rejects.toThrow(/MotifInUse/)
    await invokeCmd(page, 'project_undo')

    await invokeCmd(page, 'delete_motif', { motif_id: id })
    expect((await projectRows()).find((m) => m.id === id)).toBeUndefined()
    // Removed from the table, never from the disk: the folder is the author's.
    expect(existsSync(row!.path)).toBe(true)
    // One recorded step: undo brings the Motif back to the project.
    await invokeCmd(page, 'project_undo')
    expect((await projectRows()).find((m) => m.id === id)).toMatchObject({ status: 'ok' })
  } finally {
    await closeAppRobustly(app)
  }
})
