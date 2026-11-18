import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { readFileSync } from 'node:fs'
import { isProjectPath, parseProjectPath } from '../../shared/projectPath'
import { upgradeWire, type FilePlan } from './migrate'

type WireItem = Record<string, unknown>
const HASH = 'ab'.repeat(32)
const VOICE = 'c0ffee11'.repeat(8)

function item(id: string, over: WireItem): WireItem {
  return {
    id, label: null, path_abs: `/home/u/Old/${id}.mp4`, path_rel: `Media/${id}.mp4`, kind: 'Video',
    metadata: { duration_us: 1_000_000 }, file_hash_blake3: HASH, file_size: 1, file_mtime: 0,
    imported_at: '2026-01-01T00:00:00Z', decode_route: { route: 'bypass' },
    conform_path: null, waveform_path: null, thumbnails_dir: null, ...over,
  }
}

/** A v6 wire holding `items` in its media pool. */
function v6(items: WireItem[]): Record<string, unknown> {
  const wire = JSON.parse(readFileSync('fixtures/projects/v6.json', 'utf8')) as Record<string, unknown>
  wire.media_pool = Object.fromEntries(items.map(i => [i.id as string, i]))
  return wire
}

function upgrade(items: WireItem[]): { pool: Record<string, WireItem>; plans: FilePlan[] } {
  const plans: FilePlan[] = []
  const { wire } = upgradeWire(v6(items), 6, 7, undefined, { onFile: plan => plans.push(plan) })
  return { pool: wire.media_pool as Record<string, WireItem>, plans }
}

const relOf = (items: WireItem[]) => Object.fromEntries(Object.entries(upgrade(items).pool).map(([id, i]) => [id, i.path_rel]))

describe('v6 → v7 project paths', () => {
  it('writes a path inside the folder with `/` and NFC, and drops path_abs', () => {
    const { pool } = upgrade([item('a', { path_rel: 'Media\\Interviews\\cafe\u0301.mp4', path_abs: 'C:\\Users\\u\\Film\\Media\\Interviews\\cafe\u0301.mp4' })])
    expect(pool.a!.path_rel).toBe('Media/Interviews/caf\u00e9.mp4')
    expect(pool.a).not.toHaveProperty('path_abs')
  })

  it('drops empty and `.` segments', () => {
    expect(relOf([item('a', { path_rel: 'Media//./clip.mp4' })])).toEqual({ a: 'Media/clip.mp4' })
  })

  it('rewrites each segment into a name every OS accepts', () => {
    expect(relOf([
      item('a', { path_rel: 'Media/a:b?.mp4' }),
      item('b', { path_rel: 'Media/CON.mp4' }),
      item('c', { path_rel: 'Media/take. ' }),
      item('d', { path_rel: 'Media/...' }),
      item('e', { path_rel: `Media/${'x'.repeat(300)}.mp4` }),
    ])).toEqual({
      a: 'Media/a_b_.mp4', b: 'Media/CON_.mp4', c: 'Media/take', d: 'Media/media', e: `Media/${'x'.repeat(251)}.mp4`,
    })
  })

  it('makes a path that leaves the folder external, keeping where the file was', () => {
    const { pool } = upgrade([
      item('abs', { path_rel: '/home/u/Elsewhere/clip.mp4', path_abs: '/home/u/Elsewhere/clip.mp4' }),
      item('drive', { path_rel: 'D:\\Footage\\clip.mp4', path_abs: 'D:\\Footage\\clip.mp4' }),
      item('unc', { path_rel: '\\\\server\\share\\clip.mp4', path_abs: '\\\\server\\share\\clip.mp4' }),
      item('up', { path_rel: 'Media/../../clip.mp4', path_abs: '/home/u/clip.mp4' }),
    ])
    for (const [id, abs] of [['abs', '/home/u/Elsewhere/clip.mp4'], ['drive', 'D:\\Footage\\clip.mp4'],
      ['unc', '\\\\server\\share\\clip.mp4'], ['up', '/home/u/clip.mp4']] as const) {
      expect(pool[id], id).toMatchObject({ path_rel: null, path_abs: abs })
    }
  })

  it('tells different paths that fold to one name apart, renaming none that was already valid', () => {
    expect(relOf([
      item('fixed', { path_rel: 'Media/Clip?.mp4', file_hash_blake3: '01'.repeat(32) }),
      item('upper', { path_rel: 'Media/Clip_.mp4', file_hash_blake3: '02'.repeat(32) }),
      item('lower', { path_rel: 'Media/clip_.mp4', file_hash_blake3: '03'.repeat(32) }),
    ])).toEqual({ fixed: 'Media/Clip_-3.mp4', upper: 'Media/Clip_.mp4', lower: 'Media/clip_-2.mp4' })
  })

  it('keeps one file named in two letter cases with the same bytes on one name', () => {
    // One file on Windows and macOS, which fold case: renaming one spelling
    // would leave nothing on disk for relink to find under the new name.
    expect(relOf([
      item('a', { path_rel: 'Media/Clip.mp4' }),
      item('b', { path_rel: 'Media/clip.mp4' }),
      item('other', { path_rel: 'Media/CLIP.mp4', file_hash_blake3: '04'.repeat(32) }),
    ])).toEqual({ a: 'Media/Clip.mp4', b: 'Media/Clip.mp4', other: 'Media/CLIP-2.mp4' })
  })

  it('keeps items that named one file on one file', () => {
    expect(relOf([
      item('a', { path_rel: 'Media\\clip.mp4' }),
      item('b', { path_rel: 'Media/clip.mp4' }),
    ])).toEqual({ a: 'Media/clip.mp4', b: 'Media/clip.mp4' })
  })

  it('leaves only the route tag and no derivative path', () => {
    const { pool } = upgrade([item('a', {
      decode_route: { route: 'native-sw', quick_proxy: 'Cache/proxies/q.mp4', full_proxy: 'Cache/proxies/f.mp4', format_version: 6 },
      conform_path: '/home/u/Film/Cache/conform/a.wav', waveform_path: '/home/u/Film/Cache/a.wave', thumbnails_dir: '/home/u/Film/Cache/a.thumbs',
    })])
    expect(pool.a!.decode_route).toEqual({ route: 'native-sw' })
    for (const field of ['conform_path', 'waveform_path', 'thumbnails_dir']) expect(pool.a).not.toHaveProperty(field)
  })

  it('plans the move of a full proxy kept under the v7 recipe\'s old name', () => {
    const route = (full: string, format_version: number) => ({ route: 'proxied', quick_proxy: null, full_proxy: full, format_version })
    const { plans } = upgrade([
      item('old', { decode_route: route(`C:\\Users\\u\\Film\\Cache\\proxies\\${HASH}.mp4`, 7) }),
      item('older', { file_hash_blake3: 'cd'.repeat(32), decode_route: route(`/home/u/Film/Cache/proxies/${'cd'.repeat(32)}.mp4`, 6) }),
      item('named', { file_hash_blake3: 'ef'.repeat(32), decode_route: route(`/home/u/Film/Cache/proxies/${'ef'.repeat(32)}.full-p7.mp4`, 7) }),
    ])
    expect(plans).toEqual([{ from: `Cache/proxies/${HASH}.mp4`, to: `Cache/proxies/${HASH}.full-p7.mp4`, mode: 'move' }])
  })

  it('moves a cached voiceover into Media/Voiceover/, to be hashed on open', () => {
    const cached = (dir: string) => ({ path_rel: null, path_abs: `${dir}${VOICE}.mp3`, kind: 'Audio' })
    const { pool, plans } = upgrade([
      item('taken', { path_rel: `Media/Voiceover/voiceover-${VOICE.slice(0, 8)}.mp3` }),
      item('vo', cached('C:\\Users\\u\\Film\\Cache\\voiceover\\')),
      item('again', cached('/home/u/Film/Cache/voiceover/')),
    ])
    const to = `Media/Voiceover/voiceover-${VOICE.slice(0, 8)}-2.mp3`
    expect(pool.vo).toMatchObject({ path_rel: to, file_hash_blake3: 'pending-vo' })
    expect(pool.vo).not.toHaveProperty('path_abs')
    expect(pool.again).toMatchObject({ path_rel: to, file_hash_blake3: 'pending-again' })
    expect(plans).toEqual([{ from: `Cache/voiceover/${VOICE}.mp3`, to, mode: 'copy', recorded: `C:\\Users\\u\\Film\\Cache\\voiceover\\${VOICE}.mp3` }])
  })

  it('leaves an external item that is not a voiceover where it is', () => {
    const { pool, plans } = upgrade([item('ext', { path_rel: null, path_abs: 'C:\\Users\\u\\Videos\\take.mov' })])
    expect(pool.ext).toMatchObject({ path_rel: null, path_abs: 'C:\\Users\\u\\Videos\\take.mov', file_hash_blake3: HASH })
    expect(plans).toEqual([])
  })

  it('never throws, and writes only paths the live parser accepts', () => {
    // Biased toward the characters the rules are about.
    const char = fc.oneof(
      fc.constantFrom('/', '\\', '.', ' ', ':', '?', '*', '<', '|', '"', '\u0000', '\u001f', 'C', 'o', 'n', 'e\u0301', '\u00e9', '\u{1F3AC}', '视'),
      fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
    )
    const rel = fc.oneof(
      fc.array(char, { maxLength: 40 }).map(cs => cs.join('')),
      fc.array(fc.array(char, { maxLength: 300 }).map(cs => cs.join('')), { maxLength: 4 }).map(segs => segs.join('/')),
      fc.constant(null),
    )
    fc.assert(fc.property(fc.array(rel, { maxLength: 6 }), (rels) => {
      const items = rels.map((r, i) => item(`m${i}`, { path_rel: r }))
      const { pool } = upgrade(items)
      const out = Object.values(pool).map(i => i.path_rel as string | null)
      for (const p of out) if (p !== null) expect(isProjectPath(p), p).toBe(true)
      return out.every(p => p === null || parseProjectPath(p) === p)
    }), { seed: 0x5041_5448, numRuns: Number(process.env.WEFTCUT_PBT_RUNS ?? 300) })
  })
})
