import { describe, expect, it } from 'vitest'
import { formatMediaRef, isMediaPropValue, mediaPictureKey, mediaPropProblem, parseMediaRef } from './mediaProp'

const ID = '01a16264-9ec6-7eb3-9edc-f39041803cf5'

describe('media prop values', () => {
  it('name an image, a video frame, or nothing', () => {
    expect(parseMediaRef(ID)).toEqual({ media_id: ID, t_us: null })
    expect(parseMediaRef(`${ID}@1200000`)).toEqual({ media_id: ID, t_us: 1_200_000 })
    expect(parseMediaRef('')).toBeNull()
    for (const bad of ['../x', `${ID}@-1`, `${ID}@1.5`, 'a b', 5, null]) expect(isMediaPropValue(bad), String(bad)).toBe(false)
    expect(isMediaPropValue('')).toBe(true)
    expect(formatMediaRef({ media_id: ID, t_us: 1_234_567.6 })).toBe(`${ID}@1234568`)
  })

  it('key a picture by content hash, and frame time for a video', () => {
    expect(mediaPictureKey('abc', { media_id: ID, t_us: null })).toBe('abc')
    expect(mediaPictureKey('abc', { media_id: ID, t_us: 5 })).toBe('abc@5')
  })

  it('refuse a ref the pool cannot draw', () => {
    const schema = { photo: { type: 'media' }, text: { type: 'string' } }
    const pool = { img: { kind: 'Image' }, vid: { kind: 'Video' }, aud: { kind: 'Audio' } }
    expect(mediaPropProblem(schema, { photo: '', text: 'missing' }, pool)).toBeNull()
    expect(mediaPropProblem(schema, { photo: 'img' }, pool)).toBeNull()
    expect(mediaPropProblem(schema, { photo: 'vid@40000' }, pool)).toBeNull()
    expect(mediaPropProblem(schema, { photo: 'gone' }, pool)).toMatch(/not in the project — import_media/)
    expect(mediaPropProblem(schema, { photo: 'aud' }, pool)).toMatch(/Audio media/)
    expect(mediaPropProblem(schema, { photo: 'img@5' }, pool)).toMatch(/only a video takes/)
  })
})
