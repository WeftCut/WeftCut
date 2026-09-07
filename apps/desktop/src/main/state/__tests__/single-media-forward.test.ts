import { describe, it, expect, vi } from 'vitest'
import {
  SINGLE_MEDIA_CHANNELS, WAVEFORM_KEY_CHANNELS, resolveSingleMediaArgs, resolveWaveformKeyArg,
} from '../single-media-forward'
import type { MediaItem } from '../model'

const item = { id: 'm1', label: null, kind: 'Video', file_hash_blake3: 'h' } as never

describe('resolveSingleMediaArgs', () => {
  it('includes timeline filmstrip tiles in the single-media channel set', () => {
    expect(SINGLE_MEDIA_CHANNELS.has('get_filmstrip_tile')).toBe(true)
  })
  it('replaces { mediaId } with the resolved { item }', () => {
    const pool = { m1: item }
    expect(resolveSingleMediaArgs({ mediaId: 'm1' }, pool)).toEqual({ item })
  })
  it('throws a not-found error when the id is absent', () => {
    expect(() => resolveSingleMediaArgs({ mediaId: 'gone' }, {})).toThrow(/media gone not found/)
  })
  it('passes through extra args for get_waveform_tile', () => {
    const pool = { m1: { id: 'm1' } as unknown as MediaItem }
    const out = resolveSingleMediaArgs(
      { mediaId: 'm1', level: 2, channel: 1, startPeak: 0, count: 2048 } as never,
      pool,
    )
    expect(out.item).toBe(pool.m1)
    expect(out).toMatchObject({ level: 2, channel: 1, startPeak: 0, count: 2048 })
  })
  it('passes through extra args for get_filmstrip_tile', () => {
    const pool = { m1: { id: 'm1' } as unknown as MediaItem }
    const out = resolveSingleMediaArgs({ mediaId: 'm1', lod: 4, index: 12 } as never, pool)
    expect(out.item).toBe(pool.m1)
    expect(out).toMatchObject({ lod: 4, index: 12 })
  })
})

describe('resolveWaveformKeyArg', () => {
  const FX_KEY = 'fx:abc123.fx-0123456789abcdef'
  const FX_PATH = '/cache/waveforms/abc123.fx-0123456789abcdef.v4.peaks'

  it('lists exactly the two channels that carry a waveform key', () => {
    expect([...WAVEFORM_KEY_CHANNELS].sort()).toEqual(['get_waveform_levels', 'get_waveform_tile'])
  })

  it('turns an fx key into the explicit waveformPath and keeps the other args', () => {
    const resolve = vi.fn(() => FX_PATH)
    const out = resolveWaveformKeyArg(
      { mediaId: 'm1', level: 2, channel: 1, waveformKey: FX_KEY }, resolve,
    )
    expect(out).toEqual({ mediaId: 'm1', level: 2, channel: 1, waveformPath: FX_PATH })
    expect(resolve).toHaveBeenCalledWith(FX_KEY)
  })

  // A media-id key is the default; Rust then reads item.waveform_path, which is
  // the raw-conform waveform.
  it('drops a media-id key without consulting the baker', () => {
    const resolve = vi.fn(() => FX_PATH)
    const out = resolveWaveformKeyArg({ mediaId: 'm1', waveformKey: 'm1' }, resolve)
    expect(out).toEqual({ mediaId: 'm1' })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('passes args with no key through untouched', () => {
    expect(resolveWaveformKeyArg({ mediaId: 'm1', lod: 3 }, () => null)).toEqual({ mediaId: 'm1', lod: 3 })
  })

  // The renderer already drops to the media-id key on not_ready, so this is
  // what makes an evicted peaks sibling degrade to the raw waveform instead of
  // silently drawing it as if it were the processed one.
  it('raises not_ready when the baker cannot resolve the key', () => {
    expect(() => resolveWaveformKeyArg({ mediaId: 'm1', waveformKey: FX_KEY }, () => null))
      .toThrow(/not_ready/)
  })
})
