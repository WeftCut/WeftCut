import { describe, it, expect, vi } from 'vitest'
import {
  resolveClipSliceArgs,
  resolvePauseComputeArgs,
  resolveTwoSliceArgs,
  CLIP_SLICE_TOOLS,
  TWO_SLICE_TOOLS,
} from '../clip-slice-forward'

const media = { id: 'm1', file_hash_blake3: 'h' } as never
const media2 = { id: 'm2', file_hash_blake3: 'h2' } as never
const vclip = { id: 'L1', params: { kind: 'VideoClip', media: 'm1' } } as never
const vclip2 = { id: 'L3', params: { kind: 'VideoClip', media: 'm2' } } as never
const text = { id: 'L2', params: { kind: 'Text', content: 'hi' } } as never
const snap = { compositions: { r: { tracks: [{ layers: [vclip, vclip2, text] }] } }, root_id: 'r', media_pool: { m1: media, m2: media2 } } as never

describe('resolveClipSliceArgs', () => {
  it('injects the layer and its MediaItem for an AV layer, preserving args', () => {
    const out = resolveClipSliceArgs({ layer_id: 'L1', threshold_amp: 0.02 }, snap)
    expect(out.layer).toBe(vclip)
    expect(out.media).toBe(media)
    expect(out.threshold_amp).toBe(0.02)
  })
  it('null layer + null media when the layer id is absent', () => {
    expect(resolveClipSliceArgs({ layer_id: 'gone' }, snap)).toMatchObject({ layer: null, media: null })
  })
  it('null media for a non-AV layer (Rust produces the not-analyzable error)', () => {
    const out = resolveClipSliceArgs({ layer_id: 'L2' }, snap)
    expect(out.layer).toBe(text)
    expect(out.media).toBeNull()
  })
  it('lists exactly the clip-slice compute tools', () => {
    expect([...CLIP_SLICE_TOOLS].sort()).toEqual(
      ['analyze_clip', 'describe_clip', 'detect_pauses', 'extract_clip_audio', 'transcribe_clip'],
    )
  })
})

describe('resolveTwoSliceArgs', () => {
  it('lists exactly the two-slice compute tools', () => {
    expect([...TWO_SLICE_TOOLS].sort()).toEqual(['compare_frames'])
  })
  it('injects the slice into both nested a/b, preserving their t_us', () => {
    const out = resolveTwoSliceArgs(
      { a: { layer_id: 'L1', t_us: 1_000_000 }, b: { layer_id: 'L3', t_us: 2_000_000 } },
      snap,
    )
    expect(out.a).toMatchObject({ layer: vclip, media, t_us: 1_000_000 })
    expect(out.b).toMatchObject({ layer: vclip2, media: media2, t_us: 2_000_000 })
  })
  it('same-clip pair resolves both sides to the same layer/media', () => {
    const out = resolveTwoSliceArgs(
      { a: { layer_id: 'L1', t_us: 0 }, b: { layer_id: 'L1', t_us: 500_000 } },
      snap,
    )
    expect(out.a).toMatchObject({ layer: vclip, media })
    expect(out.b).toMatchObject({ layer: vclip, media })
  })
  it('null layer + null media when a side layer id is absent or non-video', () => {
    const out = resolveTwoSliceArgs(
      { a: { layer_id: 'gone', t_us: 0 }, b: { layer_id: 'L2', t_us: 0 } },
      snap,
    )
    expect(out.a).toMatchObject({ layer: null, media: null })
    expect(out.b).toMatchObject({ layer: text, media: null })
  })
  it('tolerates a missing side object (Rust produces the not-found error)', () => {
    const out = resolveTwoSliceArgs({ a: { layer_id: 'L1', t_us: 0 } }, snap)
    expect(out.a).toMatchObject({ layer: vclip, media })
    expect(out.b).toMatchObject({ layer: null, media: null })
  })
})

// `detect_pauses` is the one clip-compute tool whose slice is not the layer the
// caller named: it resolves the SUBJECT that plays, and carries the peaks file
// that subject's effect chain baked (spec Decisions 1 and 11).
const audio = { id: 'A1', params: { kind: 'Audio', media: 'm2' } } as never
const pauseSnap = {
  compositions: { r: { tracks: [{ layers: [vclip, audio, text] }], links: [{ id: 'k1', members: ['A1', 'L1'] }] } },
  root_id: 'r',
  media_pool: { m1: media, m2: media2 },
} as never

describe('resolvePauseComputeArgs', () => {
  it('injects the subject Audio layer, its media and the fx peaks path', () => {
    const peaksPathFor = vi.fn(() => 'C:/cache/fx/abc.peaks')
    const out = resolvePauseComputeArgs({ layer_id: 'A1', threshold_amp: 0.02 }, pauseSnap, peaksPathFor)
    expect(out.layer).toBe(audio)
    expect(out.media).toBe(media2)
    expect(out.peaks_path).toBe('C:/cache/fx/abc.peaks')
    expect(out.threshold_amp).toBe(0.02)
    // Keyed by the SUBJECT, never by the layer the caller named — the bake state
    // hangs off the layer that plays.
    expect(peaksPathFor).toHaveBeenCalledWith('A1')
  })

  it('resolves a VideoClip to its linked Audio partner, peaks and all', () => {
    const peaksPathFor = vi.fn(() => 'C:/cache/fx/abc.peaks')
    const out = resolvePauseComputeArgs({ layer_id: 'L1' }, pauseSnap, peaksPathFor)
    expect(out.layer).toBe(audio)
    expect(out.media).toBe(media2)
    expect(peaksPathFor).toHaveBeenCalledWith('A1')
  })

  it('falls back to the raw peaks when no bake is ready, rather than refusing', () => {
    // The same fallback the waveform tile fetch takes; export keeps its own
    // strict gate.
    const out = resolvePauseComputeArgs({ layer_id: 'A1' }, pauseSnap, () => null)
    expect(out.peaks_path).toBeNull()
    expect(out.layer).toBe(audio)
  })

  it('injects a null layer for a missing id and lets Rust own the not-found refusal', () => {
    expect(resolvePauseComputeArgs({ layer_id: 'gone' }, pauseSnap, () => null))
      .toMatchObject({ layer: null, media: null, peaks_path: null })
  })

  it('throws the plays-no-sound refusal for a layer with no subject', () => {
    // Rust accepts `Audio` only, so an unresolved delegation must be named here
    // in the vocabulary of the timeline rather than surfacing as a wire-shape
    // complaint about a layer kind the agent was invited to pass.
    const unlinked = {
      compositions: { r: { tracks: [{ layers: [vclip, text] }], links: [] } },
      root_id: 'r',
      media_pool: { m1: media },
    } as never
    expect(() => resolvePauseComputeArgs({ layer_id: 'L1' }, unlinked, () => null))
      .toThrow('detect_pauses: layer L1 plays no sound — it is a VideoClip with no linked Audio layer; select the audio clip')
    expect(() => resolvePauseComputeArgs({ layer_id: 'L2' }, unlinked, () => null))
      .toThrow(/plays no sound — it is a Text/)
  })
})
