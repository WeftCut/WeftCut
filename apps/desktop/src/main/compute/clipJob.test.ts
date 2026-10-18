// The singleflight key: the same source span under the same answer-changing
// args is one job, whichever layer carries it; anything that changes the
// answer is another.
import { describe, expect, it } from 'vitest'
import { clipJobSpec } from './clipJob'

const HASH = 'a'.repeat(64)
const media = (over: Record<string, unknown> = {}) => ({ id: 'm1', file_hash_blake3: HASH, ...over })
const layer = (over: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => ({
  id: 'l1', t_start_us: 1_000_000, t_end_us: 5_000_000,
  params: { kind: 'VideoClip', media: 'm1', src_in_us: 2_000_000, src_out_us: 6_000_000, ...params }, ...over,
})
const key = (args: Record<string, unknown>, tool: 'transcribe_clip' | 'describe_clip' = 'transcribe_clip') =>
  clipJobSpec(tool, { layer: layer(), media: media(), ...args })?.key

describe('clipJobSpec', () => {
  it('names the job by its first layer, media and resolved timeline window', () => {
    expect(clipJobSpec('describe_clip', { layer_id: 'l1', layer: layer(), media: media(), t_start_us: 2_000_000 })).toMatchObject({
      tool: 'describe_clip', layer_id: 'l1', media_id: 'm1', window: { t_start_us: 2_000_000, t_end_us: 5_000_000 },
    })
  })

  it('is null for an unresolved slice, which runs as a plain call', () => {
    expect(clipJobSpec('transcribe_clip', { layer: null, media: null })).toBeNull()
    expect(clipJobSpec('transcribe_clip', { layer: layer(), media: null })).toBeNull()
  })

  it('joins another layer playing the same source span', () => {
    // Same source mapping, moved along the timeline and on another media item
    // of the same file: same samples, same question.
    const moved = clipJobSpec('transcribe_clip', {
      layer: layer({ id: 'l2', t_start_us: 9_000_000, t_end_us: 13_000_000 }), media: media({ id: 'm2' }),
    })
    expect(moved?.key).toBe(key({}))
  })

  it('separates every answer-changing arg, the tool, the span and the source', () => {
    const base = key({})
    for (const args of [{ language: 'en' }, { backend: 'openai' }, { preferred_backend: 'whisper_cpp' }, { normalize_audio: true }, { word_timestamps: false }, { t_end_us: 4_000_000 }]) {
      expect(key(args), JSON.stringify(args)).not.toBe(base)
    }
    expect(key({}, 'describe_clip')).not.toBe(base)
    expect(key({ layer: layer({}, { src_in_us: 0 }) })).not.toBe(base)
    expect(key({ media: media({ file_hash_blake3: 'b'.repeat(64) }) })).not.toBe(base)
    for (const args of [{ fps: 2 }, { focus: 'shot-type' }, { vlm_config: { qwen3_vl: { model: 'x' } } }]) {
      expect(key(args, 'describe_clip'), JSON.stringify(args)).not.toBe(key({}, 'describe_clip'))
    }
  })

  it('ignores args that do not change the answer', () => {
    expect(key({ layer_id: 'l1', request_id: 'r' })).toBe(key({}))
  })

  it('never joins two items whose hash is still a placeholder', () => {
    const a = clipJobSpec('transcribe_clip', { layer: layer(), media: media({ id: 'm1', file_hash_blake3: 'pending-1' }) })
    const b = clipJobSpec('transcribe_clip', { layer: layer(), media: media({ id: 'm2', file_hash_blake3: 'pending-1' }) })
    expect(a?.key).not.toBe(b?.key)
  })
})
