import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createActor } from '../actor'
import { blankProject } from '../model'
import { seededGen } from '../ids'
import { serializeProject } from '../serialize'

const nativePath = fileURLToPath(new URL('../../../../native/index.js', import.meta.url))
const nativeAvailable = (() => {
  try { createRequire(import.meta.url)(nativePath); return true } catch { return false }
})()

describe.skipIf(!nativeAvailable)('MCP-authored animation crosses the native export seam', () => {
  it('accepts generated keyframe UUIDs and reproduces the former export error with a custom id', () => {
    const idGen = seededGen()
    const actor = createActor({ initial: blankProject(idGen, 'Synthetic animation'), idGen, clock: () => '2025-01-01T00:00:00.000Z' })
    const added = actor.command('add_text_layer', { content: 'Example', tStartUs: 0, durationUs: 2_000_000 })
    if (!added.ok) throw new Error('setup failed')
    const result = actor.mcpCall('set_param_track', JSON.stringify({ layer_id: added.value, param_key: 'opacity', track: {
      mode: 'Keyframed', value: [{ t_us: 0, value: 0 }, { t_us: 1_000_000, value: 1 }],
    } }))
    expect(result.ok, JSON.stringify(result)).toBe(true)
    const project = structuredClone(serializeProject(actor.snapshot()))
    const work = mkdtempSync(path.join(tmpdir(), 'weftcut-animation-export-'))
    // Isolate native runtime lifetime from Vitest. This calls the same native
    // audio-conform preflight used before video encoding, with no user media.
    const probe = (input: unknown) => spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const { Backend } = require(process.argv[1]);
      const backend = new Backend(process.argv[2], process.argv[2], () => {});
      (async () => {
        await backend.init();
        console.log(await backend.invoke('ensure_export_audio_conform', JSON.stringify({ project: JSON.parse(fs.readFileSync(0, 'utf8')) })));
        process.exit(0);
      })().catch(e => { console.error(e.message); process.exit(1); });
    `, nativePath, work], { input: JSON.stringify(input), encoding: 'utf8', timeout: 20_000, windowsHide: true })
    try {
      const good = probe(project)
      expect(good.status, good.stderr).toBe(0)
      expect(good.stdout).toContain('[]')
      const params = actor.snapshot().compositions[actor.snapshot().root_id]!.tracks.flatMap(t => t.layers)[0]!.params
      if (!('opacity' in params) || params.opacity.mode !== 'Keyframed') throw new Error('missing keyframes')
      const corrupt = JSON.parse(JSON.stringify(project).replace(params.opacity.value[0]!.id, 'invalid-example-key'))
      const bad = probe(corrupt)
      expect(bad.status).toBe(1)
      expect(bad.stderr).toContain('UUID parsing failed')
    } finally { rmSync(work, { recursive: true, force: true }) }
  })
})
