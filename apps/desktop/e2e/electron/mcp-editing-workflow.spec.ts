import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import { launchApp, tmpDir } from './helpers/driver'
import type { WeftcutApi } from '../../src/shared/ipc'

interface LayerRecord {
  layer_id: string
  track_id: string
  t_start_us: number
  t_end_us: number
}

test('MCP creates, trims and moves clips, then exports the edited timeline', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  let client: Client | undefined
  let jobId: string | undefined
  try {
    const info = await page.evaluate(() => (window as unknown as { api: WeftcutApi }).api.mcp.getInfo()) as {
      url: string; bearer_token: string
    }
    client = new Client({ name: 'editing-workflow-e2e', version: '1' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url), {
      requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
    }))
    const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await client!.callTool({ name, arguments: args })
      expect(result.isError, `${name}: ${JSON.stringify(result)}`).toBeFalsy()
      expect(result.structuredContent, `${name} must return a structured result`).toBeDefined()
      return result.structuredContent as T
    }
    const read = async <T>(uri: string): Promise<T> => {
      const result = await client!.readResource({ uri })
      const content = result.contents[0]
      expect(content.mimeType).toBe('application/json')
      if (!('text' in content)) throw new Error(`Expected text resource: ${uri}`)
      return JSON.parse(content.text) as T
    }

    // Only endpoint discovery uses the app bridge. Every project read and write
    // below travels through the real SDK client and authenticated HTTP server.
    await call('create_project', {
      parent_folder: tmpDir('weftcut-mcp-workflow-project-'), name: 'Editing workflow',
      width: 640, height: 360, fps: { num: 30, den: 1 },
    })
    const track = await call<{ track_id: string }>('add_track', { label: 'Sequence' })
    // Synthetic solid clips make the exported edit observable without external
    // media, fonts, codec-specific source seeking, or calibrated SSIM floors.
    const red = await call<LayerRecord>('add_color_layer', {
      track_id: track.track_id, width: 640, height: 360, color: { r: 255, g: 0, b: 0, a: 255 },
      t_start_us: 0, t_end_us: 3_000_000,
    })
    const green = await call<LayerRecord>('add_color_layer', {
      track_id: track.track_id, width: 640, height: 360, color: { r: 0, g: 255, b: 0, a: 255 },
      t_start_us: 4_000_000, t_end_us: 6_000_000,
    })
    expect(await call<LayerRecord>('trim_layer', {
      layer_id: red.layer_id, edge: 'out', new_t_us: 1_000_000,
    })).toMatchObject({ layer_id: red.layer_id, t_start_us: 0, t_end_us: 1_000_000 })
    expect(await call<LayerRecord>('trim_layer', {
      layer_id: green.layer_id, edge: 'in', new_t_us: 5_000_000,
    })).toMatchObject({ layer_id: green.layer_id, t_start_us: 5_000_000, t_end_us: 6_000_000 })
    expect(await call<LayerRecord>('move_layer', {
      layer_id: green.layer_id, new_track_id: track.track_id, new_t_start_us: 1_000_000,
    })).toMatchObject({ layer_id: green.layer_id, track_id: track.track_id,
      t_start_us: 1_000_000, t_end_us: 2_000_000 })

    const tracks = await read<Array<{ id: string; layers: Array<{ id: string; t_start_us: number; t_end_us: number }> }>>('project://tracks')
    expect(tracks.find(t => t.id === track.track_id)?.layers.map(l => ({
      id: l.id, t_start_us: l.t_start_us, t_end_us: l.t_end_us,
    }))).toEqual([
      { id: red.layer_id, t_start_us: 0, t_end_us: 1_000_000 },
      { id: green.layer_id, t_start_us: 1_000_000, t_end_us: 2_000_000 },
    ])
    expect(await read('project://composition')).toMatchObject({
      width: 640, height: 360, fps: { num: 30, den: 1 }, duration_us: 2_000_000,
    })

    const output = path.join(tmpDir('weftcut-mcp-workflow-output-'), 'sequence.mp4')
    const started = await call<{ job_id: string }>('start_export', {
      request_id: 'editing-workflow', output_path: output, preset_id: 'builtin:match',
      settings: { encoder_engine: 'native', hw_accel: 'software', include_audio: false, fps: 30 },
    })
    jobId = started.job_id
    await expect.poll(async () => (await call<{ state: string }>('get_export_status', {
      job_id: jobId,
    })).state, { timeout: 60_000 }).toBe('completed')
    const completed = await call<{ output_path: string }>('get_export_status', { job_id: jobId })
    expect(completed.output_path).toBe(output)
    expect(statSync(completed.output_path).size).toBeGreaterThan(100)

    // Verify the file, not just the job's success: exactly 60 frames, with the
    // cut at frame 30. Samples on both sides catch gaps and stale pre-edit state.
    const probe = JSON.parse(execFileSync(process.env.FFPROBE || 'ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames,duration',
      '-of', 'json', completed.output_path,
    ], { encoding: 'utf8', timeout: 15_000 })) as {
      streams: Array<{ width: number; height: number; r_frame_rate: string; nb_read_frames: string; duration: string }>
    }
    expect(probe.streams).toHaveLength(1)
    expect(probe.streams[0]).toMatchObject({ width: 640, height: 360, r_frame_rate: '30/1', nb_read_frames: '60' })
    expect(Number(probe.streams[0].duration)).toBeCloseTo(2, 2)
    for (const [frame, expected] of [[0, [255, 0, 0]], [29, [255, 0, 0]], [30, [0, 255, 0]], [59, [0, 255, 0]]] as const) {
      const pixel = execFileSync(process.env.FFMPEG || 'ffmpeg', [
        '-v', 'error', '-i', completed.output_path,
        '-vf', `select=eq(n\\,${frame}),crop=2:2:320:180`, '-frames:v', '1',
        '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
      ], { timeout: 15_000 })
      expect(pixel.length).toBe(12)
      expected.forEach((value, channel) => expect(Math.abs(pixel[channel] - value), `frame ${frame}, channel ${channel}`).toBeLessThanOrEqual(12))
    }
    await testInfo.attach('edited-export', { body: JSON.stringify({ completed, probe }), contentType: 'application/json' })
  } finally {
    if (client) {
      if (jobId) await client.callTool({ name: 'cancel_export', arguments: { job_id: jobId } }).catch(() => {})
      try { await client.close() } finally { await app.close() }
    } else {
      await app.close()
    }
  }
})
