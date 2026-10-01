import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'

function seed(profile: string) {
  const directory = path.join(profile, 'data', 'motifs', 'cover-badge')
  mkdirSync(directory, { recursive: true })
  const manifest = { id: 'cover-badge', name: 'Cover Badge', version: 1, size: [640, 360], default_duration_s: 5, props_schema: {} }
  writeFileSync(path.join(directory, 'index.html'), `<!doctype html><html><head>
    <script id="motif-manifest" type="application/json">${JSON.stringify(manifest)}</script>
    <link rel="stylesheet" href="style.css"></head><body><div></div>
    <script>motif.define({setup(){}})</script></body></html>`)
  writeFileSync(path.join(directory, 'style.css'), 'html,body{margin:0;background:transparent}div{width:320px;height:360px;background:red}')
  return directory
}

async function cover(page: Page) {
  return page.evaluate(async () => {
    const api = (window as any).api.backend
    const entry = (await api.invoke('list_motifs')).find((m: any) => m.id === 'cover-badge')
    const bytes = await api.invoke('motif_get_cover', { id: entry.id, contentHash: entry.content_hash })
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0); bitmap.close()
    return { width: canvas.width, height: canvas.height,
      pixel: Array.from(ctx.getImageData(30, 30, 1, 1).data),
      transparent: Array.from(ctx.getImageData(canvas.width - 30, 30, 1, 1).data),
    }
  })
}

test('Motif cover pixels survive restart without opening a capture window, and asset edits invalidate them', async () => {
  test.setTimeout(120_000)
  const profile = tmpDir('weftcut-cover-profile-')
  const directory = seed(profile)
  const first = await launchApp({ userDataDir: profile })
  try {
    await waitForHook(first.page, 'captureMotifFrame')
    expect(await cover(first.page)).toEqual({ width: 480, height: 270, pixel: [255, 0, 0, 255], transparent: [0, 0, 0, 0] })
  } finally { await first.app.close() }
  const cache = path.join(profile, 'data', 'cache', 'motif-covers')
  const slot = path.join(cache, readdirSync(cache)[0]!)
  const modified = statSync(slot).mtimeMs
  const second = await launchApp({ userDataDir: profile })
  try {
    await waitForHook(second.page, 'captureMotifFrame')
    expect((await cover(second.page)).pixel).toEqual([255, 0, 0, 255])
    expect(statSync(slot).mtimeMs).toBe(modified)
    expect(await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .filter(w => w.webContents.getURL().startsWith('motif:')).length)).toBe(0)
    writeFileSync(path.join(directory, 'style.css'), 'html,body{margin:0;background:transparent}div{width:320px;height:360px;background:blue}')
    expect((await cover(second.page)).pixel).toEqual([0, 0, 255, 255])
    expect(readdirSync(cache)).toHaveLength(1)
  } finally { await second.app.close() }
})

test('Motif picker offers per-card export and protected contextual deletion', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const profile = tmpDir('weftcut-library-profile-')
  const directory = seed(profile)
  const { app, page } = await launchApp({ userDataDir: profile })
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-library-project-'), name: 'Library', canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } })
    await page.getByRole('menuitem', { name: 'Insert', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Motifs…', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Motifs', exact: true })
    const builtin = picker.locator('.motif-card').first()
    await builtin.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Export Motif ZIP' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Delete Motif' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(picker).toBeVisible()
    await picker.getByLabel('Search motifs…').fill('Cover Badge')
    const card = picker.locator('.motif-card')
    await expect(card.locator('img')).toBeVisible()
    await expect(picker.locator('.motif-picker-bar').getByRole('button', { name: 'Export Motif ZIP' })).toHaveCount(0)
    const destination = path.join(profile, 'export.zip')
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, destination)
    await card.getByRole('button', { name: 'Export Motif ZIP' }).click()
    await expect.poll(() => existsSync(destination)).toBe(true)
    await card.click({ button: 'right' })
    await page.screenshot({ path: testInfo.outputPath('motif-menu.png') })
    await page.getByRole('menuitem', { name: 'Delete Motif' }).click()
    const confirm = page.getByRole('dialog', { name: 'Delete Motif', exact: true })
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    expect(existsSync(directory)).toBe(true)
    await card.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete Motif' }).click()
    await confirm.getByRole('button', { name: 'Delete Motif' }).click()
    await expect(card).toHaveCount(0)
    expect(existsSync(directory)).toBe(false)
    await expect(picker).toBeVisible()
  } finally { await app.close() }
})
