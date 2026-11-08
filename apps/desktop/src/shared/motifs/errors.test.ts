import { describe, expect, it } from 'vitest'
import { asMotifCapacity, decodeMotifError, decodingMotifErrors, MotifError, motifErrorCode } from './errors'

describe('Motif error codes', () => {
  it('tags the message with the wire literal', () => {
    // LANDMINE: the same literal is pinned in `native/src/motif_error.rs`.
    expect(new MotifError('miss', 'x').message).toBe('[motif:miss] x')
  })

  it('reads a code only from a MotifError in process', () => {
    expect(motifErrorCode(new MotifError('disk', 'full'))).toBe('disk')
    expect(motifErrorCode(new Error('[motif:disk] full'))).toBeUndefined()
    expect(motifErrorCode('[motif:disk] full')).toBeUndefined()
  })

  it('decodes a tag behind the prefix Electron adds to a remote method failure', () => {
    const remote = new Error("Error invoking remote method 'motif:capture': Error: [motif:superseded] superseded by a newer request")
    const decoded = decodeMotifError(remote)
    expect(decoded).toBeInstanceOf(MotifError)
    expect(decoded).toMatchObject({ code: 'superseded', detail: 'superseded by a newer request', cause: remote })
    expect((decoded as Error).message).toBe('[motif:superseded] superseded by a newer request')
  })

  it('passes untagged, unknown-code and already decoded errors through', () => {
    const plain = new Error('boom')
    const unknown = new Error('[motif:bogus] x')
    const coded = new MotifError('device', 'gone')
    expect(decodeMotifError(plain)).toBe(plain)
    expect(decodeMotifError(unknown)).toBe(unknown)
    expect(decodeMotifError(coded)).toBe(coded)
  })

  it('decodes a native rejection', async () => {
    await expect(decodingMotifErrors(() => Promise.reject(new Error('[motif:oversize] Motif GPU pool exceeds budget'))))
      .rejects.toMatchObject({ code: 'oversize' })
  })

  it('turns the app-wide capacity refusal into a capacity code that still matches it', () => {
    const refusal = new Error('resource-capacity-exceeded: busy')
    const coded = asMotifCapacity(refusal)
    expect(coded).toMatchObject({ code: 'capacity', cause: refusal })
    expect(String(coded)).toContain('resource-capacity-exceeded')
    const other = new Error('other')
    expect(asMotifCapacity(other)).toBe(other)
  })
})
