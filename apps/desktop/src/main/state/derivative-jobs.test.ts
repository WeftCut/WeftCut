// The derivative states an agent reads (media card, refusals) come from the
// pool's paths plus the native job events main hears. A failed job must read
// as failed, never as "not generated yet" (sim L4: /tmp filled, the waveform
// job died, and detect_pauses said "wait" for ten minutes).
import { afterEach, describe, expect, it } from 'vitest'
import { derivativeStates, hasFailedDerivative, recordDerivativeJob, resetDerivativeJobs, withDerivativeState } from './derivative-jobs'
import { mediaItemTemplate } from './mutations/media'
import type { MediaItem } from './model'

const MID = '00000000-0000-0000-0000-0000000000aa'
const video = (patch: Partial<MediaItem> = {}): MediaItem => ({
  ...mediaItemTemplate(MID, 'Video', 4_000_000, true),
  decode_route: { route: 'proxied', quick_proxy: null, full_proxy: null, format_version: 1 },
  ...patch,
})
const notReady = (derivative: string) => ({
  message: `${derivative} not generated yet for media ${MID} — the import's background jobs are still generating it; retry in a few seconds`,
  data: { error: 'DerivativeNotReady', media_id: MID, derivative },
})

afterEach(() => resetDerivativeJobs())

describe('derivativeStates', () => {
  it('a fresh video reads pending for each of its derivatives', () => {
    expect(derivativeStates(video())).toEqual({ waveform: 'pending', conform: 'pending', thumbnails: 'pending', proxy: 'pending' })
  })

  it('a started job reads running, a path on the item reads ready', () => {
    recordDerivativeJob('media:job_started', { media_id: MID, kind: 'waveform' })
    recordDerivativeJob('media:job_started', { media_id: MID, kind: 'quick_proxy' })
    expect(derivativeStates(video({ conform_path: '/c/a.wav' }))).toMatchObject({ waveform: 'running', conform: 'ready', proxy: 'running' })
  })

  it('a failed waveform job reads failed with its reason', () => {
    recordDerivativeJob('media:job_started', { media_id: MID, kind: 'waveform' })
    recordDerivativeJob('media:job_error', { media_id: MID, kind: 'waveform', error: 'write peaks: Disk quota exceeded (os error 122)' })
    const states = derivativeStates(video())
    expect(states.waveform).toEqual({ failed: 'write peaks: Disk quota exceeded (os error 122)' })
    expect(hasFailedDerivative(video())).toBe(true)
    // A re-run clears it.
    recordDerivativeJob('media:job_started', { media_id: MID, kind: 'waveform' })
    expect(derivativeStates(video()).waveform).toBe('running')
  })

  it('a source that plays as it is has no proxy; a still has no derivatives', () => {
    expect(derivativeStates(video({ decode_route: { route: 'bypass' } }))).not.toHaveProperty('proxy')
    expect(derivativeStates({ ...mediaItemTemplate(MID, 'Image', null), kind: 'Image' })).toEqual({})
  })

  it('a project switch forgets the outgoing jobs', () => {
    recordDerivativeJob('media:job_error', { media_id: MID, kind: 'thumbnails', error: 'boom' })
    resetDerivativeJobs()
    expect(derivativeStates(video()).thumbnails).toBe('pending')
  })
})

describe('withDerivativeState', () => {
  it('adds the job state and a retry hint to a reader refusal', () => {
    recordDerivativeJob('media:job_started', { media_id: MID, kind: 'waveform' })
    const out = withDerivativeState(notReady('waveform'))
    expect(out.message).toMatch(/^waveform not generated yet/)
    expect(out.data).toMatchObject({ error: 'DerivativeNotReady', derivative: 'waveform', state: 'running', retry_after_s: 5 })
  })

  it('says a failed job failed, with its reason and the re-run, and no retry hint', () => {
    recordDerivativeJob('media:job_error', { media_id: MID, kind: 'waveform', error: 'Disk quota exceeded' })
    const out = withDerivativeState(notReady('waveform'))
    expect(out.message).toContain('waveform failed for media')
    expect(out.message).toContain('Disk quota exceeded')
    expect(out.message).toContain('import_media')
    expect(out.message).not.toMatch(/not generated yet|retry in a few seconds/)
    expect(out.data).toMatchObject({ state: 'failed', reason: 'Disk quota exceeded', retry_after_s: null })
  })

  it('names the thumbnail reader\'s derivative as the card does', () => {
    expect(withDerivativeState(notReady('thumbnail')).data).toMatchObject({ derivative: 'thumbnails', state: 'pending', retry_after_s: 10 })
  })

  it('leaves any other refusal alone', () => {
    const other = { message: 'layer not found', data: { error: 'LayerNotFound' } }
    expect(withDerivativeState(other)).toBe(other)
  })
})
