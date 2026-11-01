// The singleflight key: the same source span under the same answer-changing
// args is one job, whichever layer carries it; anything that changes the
// answer is another.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ARG_ROLES, clipJobSpec } from './clipJob'

const catalog = JSON.parse(readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')) as {
  tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[]
}

const HASH = 'a'.repeat(64)
const media = (over: Record<string, unknown> = {}) => ({ id: 'm1', file_hash_blake3: HASH, ...over })
const layer = (over: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => ({
  id: 'l1', t_start_us: 1_000_000, t_end_us: 5_000_000,
  params: { kind: 'VideoClip', media: 'm1', src_in_us: 2_000_000, src_out_us: 6_000_000, ...params }, ...over,
})
const key = (args: Record<string, unknown>, tool: 'transcribe_clip' | 'describe_clip' = 'transcribe_clip') =>
  clipJobSpec(tool, { layer: layer(), media: media(), ...args })?.key

describe('clipJobSpec', () => {
  it('does not join shot identification to clip content description for the same span', () => {
    expect(key({ purpose: 'shot' }, 'describe_clip')).not.toBe(key({ purpose: 'clip' }, 'describe_clip'))
    expect(key({}, 'describe_clip')).toBe(key({ purpose: 'clip' }, 'describe_clip'))
  })
  it('names the job by its first layer, media and resolved timeline window', () => {
    expect(clipJobSpec('transcribe_clip', { layer_id: 'l1', layer: layer(), media: media(), t_start_us: 2_000_000 })).toMatchObject({
      tool: 'transcribe_clip', layer_id: 'l1', media_id: 'm1', window: { t_start_us: 2_000_000, t_end_us: 5_000_000 },
    })
    // describe_clip's window is source time; the record says where the layer plays it.
    expect(clipJobSpec('describe_clip', { layer_id: 'l1', layer: layer(), media: media(), src_start_us: 3_000_000 })).toMatchObject({
      tool: 'describe_clip', window: { t_start_us: 2_000_000, t_end_us: 5_000_000 },
    })
  })

  it('keys a description by its source window, whichever layer and spelling name it', () => {
    const moved = clipJobSpec('describe_clip', {
      layer: layer({ id: 'l2', t_start_us: 9_000_000, t_end_us: 13_000_000 }), media: media({ id: 'm2' }),
    })
    expect(moved?.key).toBe(key({}, 'describe_clip'))
    expect(key({ src_start_us: 2_000_000, src_end_us: 6_000_000 }, 'describe_clip')).toBe(key({}, 'describe_clip'))
    expect(key({ src_start_us: 3_000_000 }, 'describe_clip')).not.toBe(key({}, 'describe_clip'))
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
    for (const args of [{ language: 'en' }, { backend: 'openai' }, { preferred_backend: 'whisper_cpp' }, { normalize_audio: true }, { word_timestamps: false }, { speech_config: { whisper_cpp: { kind: 'local', binary: 'w', model: 'x' } } }, { t_end_us: 4_000_000 }]) {
      expect(key(args), JSON.stringify(args)).not.toBe(base)
    }
    expect(key({}, 'describe_clip')).not.toBe(base)
    expect(key({ layer: layer({}, { src_in_us: 0 }) })).not.toBe(base)
    expect(key({ media: media({ file_hash_blake3: 'b'.repeat(64) }) })).not.toBe(base)
    for (const args of [{ fps: 2 }, { focus: 'shot-type' }, { vlm_config: { qwen3_vl: { model: 'x' } } }]) {
      expect(key(args, 'describe_clip'), JSON.stringify(args)).not.toBe(key({}, 'describe_clip'))
    }
  })

  // A new arg is either part of the question or not; nothing decides that
  // for it, so an unclassified one fails here before it can join a job.
  it.each(Object.keys(ARG_ROLES))('classifies every arg %s advertises', (tool) => {
    const advertised = Object.keys(catalog.tools.find(t => t.name === tool)!.inputSchema.properties ?? {})
    expect(advertised.filter(k => !(k in ARG_ROLES[tool as keyof typeof ARG_ROLES]))).toEqual([])
  })

  it('runs a media-addressed description as a job keyed by media + source window', () => {
    const pooled = media({ metadata: { duration_us: 9_000_000 } })
    const spec = clipJobSpec('describe_clip', { layer: null, media: pooled, media_id: 'm1' })!
    expect(spec).toMatchObject({ layer_id: '', media_id: 'm1', src_window: { src_start_us: 0, src_end_us: 9_000_000 } })
    // The same source span through a layer is the same question, so it joins.
    const through = clipJobSpec('describe_clip', { layer: layer(), media: pooled, src_start_us: 0, src_end_us: 9_000_000 })!
    expect(through.key).toBe(spec.key)
    expect(clipJobSpec('describe_clip', { layer: null, media: pooled, src_start_us: 1_000_000 })!.key).not.toBe(spec.key)
    // No known length and no end: Rust refuses it, so it runs plain.
    expect(clipJobSpec('describe_clip', { layer: null, media: media({ metadata: { duration_us: null } }) })).toBeNull()
    expect(clipJobSpec('transcribe_clip', { layer: null, media: pooled })).toBeNull()
  })

  it('never joins a refresh to a run that may answer from before it', () => {
    const plain = key({}, 'describe_clip')
    expect(key({ refresh: false }, 'describe_clip')).toBe(plain)
    expect(key({ refresh: true }, 'describe_clip')).not.toBe(plain)
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
