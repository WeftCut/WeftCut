import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { launchApp, tmpDir, importAndPlaceMedia, invokeCmd } from './helpers/driver'

async function connect(page: import('@playwright/test').Page) {
  const info = await page.evaluate(() => (window as any).api.mcp.getInfo())
  const client = new Client({ name: 'export-e2e', version: '1' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(new URL(info.url), {
    requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
  }))
  return client
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
}
async function finished(client: Client, id: string) {
  let status: any
  await expect.poll(async () => {
    status = await call(client, 'get_export_status', { job_id: id })
    return status.state
  }, { timeout: 120_000, intervals: [100, 200, 500] }).toMatch(/^(completed|failed|cancelled)$/)
  return status
}
function probe(file: string) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

test('MCP exports AV, video-only and audio-only ranges, preserves status after reconnect and refuses overwrites', async () => {
  test.setTimeout(240_000)
  const dir = tmpDir('weftcut-agent-export-')
  const source = path.join(dir, 'synthetic.mp4')
  const generated = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], { encoding: 'utf8' })
  expect(generated.status, generated.stderr).toBe(0)
  const { app, page } = await launchApp()
  let client = await connect(page)
  try {
    const names = (await client.listTools()).tools.map(t => t.name)
    for (const name of ['get_export_options', 'start_export', 'get_export_status', 'cancel_export']) expect(names).toContain(name)
    const refused = await client.callTool({ name: 'start_export', arguments: { output_path: path.join(dir, 'closed.mp4') } })
    expect(refused.isError).toBe(true)
    await call(client, 'create_project', { parent_folder: dir, name: 'Synthetic export', width: 320, height: 180, fps: {num:30,den:1} })
    await page.locator('.weft-dock-panel').first().waitFor({state:'visible'})
    await importAndPlaceMedia(page, { mediaAbsPath: source })
    const track = await call(client, 'add_track')
    const text = await call(client, 'add_text_layer', { track_id: track.track_id, content: 'SYNTHETIC', t_start_us: 0, t_end_us: 2_000_000 })
    await call(client, 'add_effect', { layer_id: text.layer_id, kind: 'brightness' })
    await call(client, 'create_group', { layer_ids: [text.layer_id], label: 'Overlay' })
    await call(client, 'add_motif_layer', { motif_id: 'lower-third', t_start_us: 0, t_end_us: 2_000_000 })
    const options = await call(client, 'get_export_options')
    expect(options.settings_schema.properties.codec).toBeDefined()
    const full = path.join(dir, 'full.mp4')
    const started = await call(client, 'start_export', { output_path: full, settings: { hwAccel: 'software' } })
    expect(fs.existsSync(full)).toBe(false)
    const blocked = await client.callTool({ name: 'add_track', arguments: {} })
    expect(blocked.isError).toBe(true)
    await expect(invokeCmd(page, 'project_close')).rejects.toThrow('ExportInProgress')
    await client.close()
    client = await connect(page)
    expect(await finished(client, started.job_id)).toMatchObject({ state: 'completed', output_path: full })
    const av = probe(full)
    expect(av.streams.map((s: any) => s.codec_type).sort()).toEqual(['audio', 'video'])
    expect(Number(av.format.duration)).toBeCloseTo(2, 1)
    const protectedBytes = fs.readFileSync(full)
    const overwrite = await client.callTool({ name: 'start_export', arguments: { output_path: full } })
    expect(overwrite.isError).toBe(true)
    expect(fs.readFileSync(full)).toEqual(protectedBytes)
    for (const [file, settings, kinds] of [
      ['video.mp4', { includeAudio: false, hwAccel: 'software' }, ['video']],
      ['audio.m4a', { includeVideo: false }, ['audio']],
    ] as const) {
      const output = path.join(dir, file)
      const job = await call(client, 'start_export', { output_path: output, settings, range: { startUs: 500_000, endUs: 1_500_000 } })
      expect(await finished(client, job.job_id)).toMatchObject({ state: 'completed' })
      const result = probe(output)
      expect(result.streams.map((s: any) => s.codec_type)).toEqual(kinds)
      expect(Number(result.format.duration)).toBeCloseTo(1, 1)
    }
    const cancelPath = path.join(dir, 'cancelled.mp4')
    const cancelJob = await call(client, 'start_export', { output_path: cancelPath, settings: { hwAccel: 'software' } })
    await call(client, 'cancel_export', { job_id: cancelJob.job_id })
    expect(await finished(client, cancelJob.job_id)).toMatchObject({ state: 'cancelled' })
    expect(fs.existsSync(cancelPath)).toBe(false)
    expect(fs.readdirSync(dir).some(name => name.startsWith('.weftcut-export-'))).toBe(false)
    await call(client, 'add_track')
  } finally {
    await client.close().catch(() => {})
    await app.close()
  }
})
