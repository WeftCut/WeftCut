import { describe, expect, it } from 'vitest'
import { parsePhase, phaseLabel, phaseText } from './compute-jobs'

describe('compute phases', () => {
  it('parses the native wire, keeping only its kind\'s fields', () => {
    expect(parsePhase({ kind: 'queued', reason: 'budget' })).toEqual({ kind: 'queued', reason: 'budget' })
    expect(parsePhase({ kind: 'queued', reason: 'playback' })).toEqual({ kind: 'queued', reason: null })
    expect(parsePhase({ kind: 'extracting', done: 2, total: 5, extra: 1 })).toEqual({ kind: 'extracting', done: 2, total: 5 })
    expect(parsePhase({ kind: 'inferring' })).toEqual({ kind: 'inferring' })
    expect(parsePhase({ kind: 'inferring', done: 40, total: 100 })).toEqual({ kind: 'inferring', done: 40, total: 100 })
    expect(parsePhase({ kind: 'teleporting' })).toBeNull()
    expect(parsePhase(null)).toBeNull()
  })

  it('states each phase in English and as a key with args', () => {
    expect(phaseText({ kind: 'queued', reason: null })).toBe('Queued')
    expect(phaseText({ kind: 'inferring', done: 1, total: 3 })).toBe('Inferring 1/3')
    expect(phaseLabel({ kind: 'queued', reason: 'finalization' })).toEqual({ i18n_key: 'compute.phase.queued_finalization' })
    expect(phaseLabel({ kind: 'extracting', done: 1, total: 4 })).toEqual({ i18n_key: 'compute.phase.extracting', i18n_args: { done: 1, total: 4 } })
    expect(phaseLabel({ kind: 'loading_model' })).toEqual({ i18n_key: 'compute.phase.loading_model' })
  })
})
