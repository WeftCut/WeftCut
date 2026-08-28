import { describe, it, expect } from 'vitest'
import { viewStateDefaults } from '../shared/view-state'
import { createViewStateStore, type ViewStateFs } from './view-state'

const WS = '/ws'
const FILE = '/ws/view.json'

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed))
  const fs: ViewStateFs = {
    exists: (p) => files.has(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v },
    writeFile: (p, t) => { files.set(p, t) },
    rename: (a, b) => { const v = files.get(a); if (v === undefined) throw new Error('ENOENT'); files.set(b, v); files.delete(a) },
    mkdirp: () => {},
  }
  return { fs, files }
}
const store = (seed?: Record<string, string>) =>
  createViewStateStore({ ...memFs(seed), join: (...p) => p.join('/') })

const tab = (composition_id: string, over: Partial<{ anchor_layer_id: string | null; px_per_sec: number; scroll_left_px: number }> = {}) =>
  ({ composition_id, anchor_layer_id: null, px_per_sec: 80, scroll_left_px: 0, ...over })

describe('view-state store', () => {
  it('defaults when no file', () => {
    expect(store().load(WS)).toEqual(viewStateDefaults())
  })

  it('round-trips the tab list, track heights and expanded tracks', () => {
    const { fs } = memFs()
    const s = createViewStateStore({ fs, join: (...p) => p.join('/') })
    s.save(WS, {
      composition_tabs: [
        tab('comp-root', { px_per_sec: 200, scroll_left_px: 640 }),
        tab('comp-g1', { anchor_layer_id: 'ref-g1', px_per_sec: 40 }),
      ],
      active_composition_id: 'comp-g1',
      preview_render_target_id: 'comp-root',
      track_heights: { t1: 64, t2: 96 },
      expanded_tracks: ['t1'],
    })
    const got = createViewStateStore({ fs, join: (...p) => p.join('/') }).load(WS)
    expect(got.composition_tabs).toEqual([
      tab('comp-root', { px_per_sec: 200, scroll_left_px: 640 }),
      tab('comp-g1', { anchor_layer_id: 'ref-g1', px_per_sec: 40 }),
    ])
    expect(got.active_composition_id).toBe('comp-g1')
    expect(got.preview_render_target_id).toBe('comp-root')
    expect(got.track_heights.t1).toBe(64)
    expect(got.track_heights.t2).toBe(96)
    expect(got.expanded_tracks).toEqual(['t1'])
  })

  it('atomic write leaves no .tmp behind', () => {
    const { fs, files } = memFs()
    createViewStateStore({ fs, join: (...p) => p.join('/') }).save(WS, viewStateDefaults())
    expect(files.has(FILE)).toBe(true)
    expect(files.has(FILE + '.tmp')).toBe(false)
  })

  it('tolerates an empty file → defaults', () => {
    expect(store({ [FILE]: '' }).load(WS)).toEqual(viewStateDefaults())
  })

  it('tolerates a garbage file → defaults', () => {
    expect(store({ [FILE]: '{ not json' }).load(WS)).toEqual(viewStateDefaults())
  })

  // The blank-timeline trap: a field the renderer reads and this store never
  // wrote must arrive as its default, not as `undefined`.
  it('missing fields inherit defaults', () => {
    expect(store({ [FILE]: '{}' }).load(WS)).toEqual(viewStateDefaults())
  })

  // A tab with no composition names nothing, so there is no Panel to reopen;
  // every other field of a surviving entry is worth defaulting, because a tab
  // is still worth reopening at the default zoom.
  it('drops a tab with no composition id and defaults the rest of one that has it', () => {
    const got = store({
      [FILE]: JSON.stringify({
        composition_tabs: [
          { px_per_sec: 120 },
          { composition_id: 'comp-g1' },
          { composition_id: 'comp-g2', px_per_sec: 'wide', anchor_layer_id: 7 },
          'not-an-object',
        ],
      }),
    }).load(WS)
    expect(got.composition_tabs).toEqual([tab('comp-g1'), tab('comp-g2')])
  })

  it('reads a non-string active tab as none', () => {
    const got = store({ [FILE]: JSON.stringify({ active_composition_id: 42 }) }).load(WS)
    expect(got.active_composition_id).toBeNull()
  })

  it('reads a non-string preview render target as follow-focus', () => {
    const got = store({ [FILE]: JSON.stringify({ preview_render_target_id: 42 }) }).load(WS)
    expect(got.preview_render_target_id).toBeNull()
  })
})
