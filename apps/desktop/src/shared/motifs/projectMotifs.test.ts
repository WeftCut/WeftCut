import { describe, expect, it } from 'vitest'
import { collisionId, isNewMotifId, libraryHost, libraryIdOfHost, MOTIF_HOST_LABEL_CHARS, proposalOfHost, proposalPreviewId } from './projectMotifs'

const UID = '9c46c851-46f6-4a86-9518-8a0a118dbc69'

describe('project Motif ids and hosts', () => {
  it('suffixes a collision with the first 8 hex digits of the lineage, within one host label', () => {
    expect(collisionId('lower-third', UID)).toBe('lower-third-9c46c851')
    const long = collisionId('a'.repeat(MOTIF_HOST_LABEL_CHARS), UID)
    expect(long.length).toBeLessThanOrEqual(MOTIF_HOST_LABEL_CHARS)
    expect(long.endsWith('-9c46c851')).toBe(true)
    expect(isNewMotifId(collisionId(`${'a'.repeat(53)}-b-c`, UID))).toBe(true)
  })

  it('names each scope by its own host, and no new id reads as another scope', () => {
    expect(libraryIdOfHost(libraryHost('lower'))).toBe('lower')
    expect(proposalOfHost(proposalPreviewId('p1'))).toBe('p1')
    expect(libraryIdOfHost('lower')).toBeNull()
    expect(isNewMotifId(libraryHost('lower'))).toBe(false)
    expect(isNewMotifId(proposalPreviewId('lower'))).toBe(false)
  })
})
