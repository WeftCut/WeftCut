import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'

// Control workload for the opt-in probe, not a hard performance assertion:
// real pointer release -> actor -> summary -> renderer -> debounced disk write.
test('post-drag timing correlates all phases on a dense synthetic timeline', async ({}, info) => {
  test.setTimeout(90_000)
  const { app, page } = await launchApp()
  const rows: Record<string, any>[] = []
  let pending = ''
  const collect = (chunk: Buffer) => {
    pending += chunk.toString()
    const lines = pending.split('\n'); pending = lines.pop() ?? ''
    for (const line of lines) {
      const at = line.indexOf('[DEBUG-edit-latency] ')
      if (at < 0) continue
      try { rows.push(JSON.parse(line.slice(at + '[DEBUG-edit-latency] '.length, line.lastIndexOf('}') + 1))) }
      catch { /* Other Electron console output is not a timing record. */ }
    }
  }
  app.process().stdout?.on('data', collect)
  try {
    const parent = tmpDir('weftcut-edit-latency-')
    await newProject(page, { parentFolder: parent, name: 'seed',
      canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 } })
    await invokeCmd(page, 'add_color_layer', { tStartUs: 0, durationUs: 62_000_000 })
    await invokeCmd(page, 'project_save')
    const fixture = JSON.parse(fs.readFileSync(path.join(parent, 'seed', 'project.json'), 'utf8'))
    const root = fixture.compositions[fixture.root_id]
    const track = root.tracks.find((t: any) => t.layers.length > 0)
    const prototype = track.layers[0]
    track.layers = Array.from({ length: 62 }, (_, i) => ({ ...prototype, id: randomUUID(),
      t_start_us: i * 1_000_000, t_end_us: (i + 1) * 1_000_000 }))
    root.markers = Array.from({ length: 287 }, (_, i) => ({ id: randomUUID(),
      t_us: i === 0 ? 1_000_000 : Math.round((150 + i * 5) * 1_000_000 / 30),
      end_t_us: null, label: `Synthetic ${i}`, note: '', anchor: null,
      color: { r: 230, g: 160, b: 40, a: 255 } }))
    const denseDir = path.join(parent, 'dense')
    fs.mkdirSync(denseDir)
    fs.writeFileSync(path.join(denseDir, 'project.json'), JSON.stringify(fixture))
    await invokeCmd(page, 'project_open', { path: denseDir })
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })
    const marker = page.locator(`[data-testid="timeline-marker"][data-marker-id="${root.markers[0].id}"]`)
    await expect(marker).toBeVisible()
    await page.evaluate(() => localStorage.setItem('weftcut.debug.editTrace', '1'))
    const box = await marker.boundingBox()
    if (!box) throw new Error('Missing marker geometry')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => rows.some(r => r.phase === 'renderer.frames')).toBe(true)
    const command = rows.find(r => r.phase === 'main.command.update_marker')
    expect(command).toMatchObject({ markers: 287, layers: 62, commandAccepted: true })
    const correlated = rows.filter(r => r.traceId === command!.traceId)
    expect(correlated.map(r => r.phase)).toEqual(expect.arrayContaining([
      'renderer.invoke.update_marker', 'renderer.refresh', 'main.summary', 'main.autosave', 'renderer.frames',
    ]))
    const refresh = correlated.find(r => r.phase === 'renderer.refresh')
    expect(refresh).toMatchObject({ applied: true, frameOpportunityObserved: true })
    // One marker on a dense timeline crosses as a handful of patches, not a summary.
    expect(refresh!.patches).toBeGreaterThan(0)
    expect(refresh!.patches).toBeLessThan(16)
    expect(correlated.find(r => r.phase === 'main.autosave')?.spans.map((s: any) => s.stage))
      .toEqual(expect.arrayContaining(['serialize', 'write_file']))
    await info.attach('edit-latency', { body: JSON.stringify(correlated, null, 2), contentType: 'application/json' })
    console.log('[edit-latency-control]', JSON.stringify(correlated))
  } finally {
    app.process().stdout?.off('data', collect)
    await app.close()
  }
})
