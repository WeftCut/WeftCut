import { describe, expect, it, vi } from 'vitest'
import { RendererImportDiagnostics } from './importDiagnostics'

describe('renderer import milestones', () => {
  it('reports once, requires a main-issued token, and drops obsolete sessions', () => {
    const send = vi.fn(), d = new RendererImportDiagnostics(send)
    d.report('m', 'first_frame_submitted')
    expect(send).not.toHaveBeenCalled()
    d.track({ import_id: 'request', media_id: 'm' })
    d.report('m', 'first_frame_submitted', 'ffmpeg')
    d.report('m', 'first_frame_submitted', 'ffmpeg')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ import_id: 'request', media_id: 'm', milestone: 'first_frame_submitted', engine: 'ffmpeg' })
    expect(d.pending('m', 'first_frame_submitted')).toBe(false)
    d.track({ reset: true }); d.report('m', 'audio_prepared')
    expect(send).toHaveBeenCalledTimes(1)
    d.track({ import_id: 'next', media_id: 'm' })
    d.track({ remove: true, import_id: 'request' })
    expect(d.pending('m', 'audio_prepared')).toBe(true)
    d.track({ remove: true, import_id: 'next' })
    expect(d.pending('m', 'audio_prepared')).toBe(false)
  })
  it('a closed diagnostic transport never interrupts playback', () => {
    const d = new RendererImportDiagnostics(() => { throw Error('closed') })
    d.track({ import_id: 'request', media_id: 'm' })
    expect(() => d.report('m', 'audio_prepared')).not.toThrow()
  })
})
