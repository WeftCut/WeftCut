import { beforeEach, describe, it, expect, vi } from 'vitest'
import { injectProjectArgs, EXPORT_PROJECT_CHANNELS } from '../export-project-forward'
import { blankProject } from '../model'
import { uuidV7Gen } from '../ids'

describe('injectProjectArgs', () => {
  it('adds the wire-shape project and preserves existing args', () => {
    const p = blankProject(uuidV7Gen(), 'export-test')
    const out = injectProjectArgs({ outputPath: 'a.m4a', startUs: null, endUs: null }, p)
    expect(out.outputPath).toBe('a.m4a')
    expect(out.startUs).toBeNull()
    expect((out.project as { project_id: string }).project_id).toBe(p.project_id)
    expect((out.project as { schema_version: number }).schema_version).toBe(p.schema_version)
  })

  it('lists exactly the two audio-export channels', () => {
    expect([...EXPORT_PROJECT_CHANNELS].sort()).toEqual(
      ['ensure_export_audio_conform', 'export_project_audio_only'],
    )
  })
})

describe('injectProjectArgs — baked audio sources', () => {
  const p = blankProject(uuidV7Gen(), 'fx-export')
  const sources = { 'layer-1': '/cache/audio/h.fx-0123456789abcdef.conform' }
  const baker = { layerAudioSources: vi.fn(() => sources) }

  beforeEach(() => { baker.layerAudioSources.mockClear() })

  it('injects the baker map on the mix channel and forwards the export window', () => {
    const out = injectProjectArgs(
      { outputPath: 'a.m4a', startUs: 1_000, endUs: 5_000 }, p, 'export_project_audio_only', baker,
    )
    expect(out.layerAudioSources).toEqual(sources)
    expect(baker.layerAudioSources).toHaveBeenCalledWith(p, { start_us: 1_000, end_us: 5_000 })
  })

  it('passes a null window when either bound is absent (the whole project)', () => {
    injectProjectArgs({ startUs: null, endUs: null }, p, 'export_project_audio_only', baker)
    expect(baker.layerAudioSources).toHaveBeenCalledWith(p, null)
  })

  // The gate reports which RAW conforms are missing; a bake reads one of those,
  // so redirecting it there would be circular.
  it('never injects on the conform gate', () => {
    const out = injectProjectArgs({}, p, 'ensure_export_audio_conform', baker)
    expect(out.layerAudioSources).toBeUndefined()
    expect(baker.layerAudioSources).not.toHaveBeenCalled()
  })

  it('omits the key entirely when nothing is baked', () => {
    const empty = { layerAudioSources: () => ({}) }
    const out = injectProjectArgs({}, p, 'export_project_audio_only', empty)
    expect('layerAudioSources' in out).toBe(false)
  })
})
