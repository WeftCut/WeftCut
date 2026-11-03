import { describe, expect, it } from 'vitest'
import { hardwareProbeDiagnostic } from './decode-hardware-diagnostic'
describe('hardware probe evidence classification', () => {
  it('accepts only the native probe’s observed software-frame verdict as unavailability', () => {
    const reason = 'decoder produced YUV420P, not the hw surface (hardware decode unavailable)'
    expect(hardwareProbeDiagnostic(reason)).toEqual({ kind: 'unavailable', reason })
    expect(hardwareProbeDiagnostic(reason, true).kind).toBe('failed')
    expect(hardwareProbeDiagnostic('decoder produced YUV420P, not D3D11 (hardware decode unavailable)').kind).toBe('unavailable')
  })
  it('accepts a first hardware frame that failed on a file software decoded', () => {
    const reason = 'decoder failed the first hardware frame (Unknown error occurred) but decoded it in software (hardware decode unavailable)'
    expect(hardwareProbeDiagnostic(reason)).toEqual({ kind: 'unavailable', reason })
    expect(hardwareProbeDiagnostic(reason, true).kind).toBe('failed')
  })
  it.each(['timeout', 'driver unsupported', 'file not found', 'no frame decoded', 'Unknown error occurred', null])('does not turn %s into an environmental skip', reason => {
    expect(hardwareProbeDiagnostic(reason).kind).toBe('failed')
  })
})
