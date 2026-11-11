// apps/desktop/src/main/state/__tests__/pool-files.publication.test.ts
//
// The publication path reads the pool's files only for items it has not seen;
// what changes outside the app comes in on window focus (`refresh`), and what
// the app itself writes or removes comes in with the item or a recheck.
import { describe, it, expect, vi } from 'vitest'
import { createTsActorHost } from '../ts-actor-host'
import { applyDerivativesEvent } from '../jobs-writeback'
import { mediaItemTemplate } from '../mutations/media'
import type { FileStat } from '../poolFiles'
import type { MediaItem } from '../model'

const HASH = 'a'.repeat(64)
const FILE: FileStat = { size: 100, mtimeSecs: 50 }

function makeHost() {
  const vfs: Record<string, string> = {}
  const dirs = new Set<string>()
  const memFs = {
    exists: (p: string) => p in vfs || dirs.has(p),
    readFile: (p: string) => { if (!(p in vfs)) throw new Error(`vfs: no ${p}`); return vfs[p]! },
    writeFile: (p: string, t: string) => { vfs[p] = t },
    rename: (a: string, b: string) => { vfs[b] = vfs[a]!; delete vfs[a] },
    mkdirp: (d: string) => { dirs.add(d) },
    copyFile: (s: string, d: string) => { vfs[d] = vfs[s]! },
    readdir: (d: string) => Object.keys(vfs).filter((k) => k.startsWith(d + '/') && !k.slice(d.length + 1).includes('/')).map((k) => k.slice(d.length + 1)),
    rm: (p: string) => { delete vfs[p] },
  }
  // The pool's files: a disk of regular files, every stat counted.
  const disk = new Map<string, FileStat>()
  const poolFs = {
    stat: vi.fn((p: string) => disk.get(p) ?? null),
    statAsync: vi.fn(async (p: string) => disk.get(p) ?? null),
  }
  let wsDir: string | null = null
  const sent: { event: string; payload: unknown }[] = []
  const host = createTsActorHost({
    send: (event, payload) => { sent.push({ event, payload }) },
    poolFs,
    fs: memFs,
    join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
    napi: { commitWorkspace: async (p: string) => { wsDir = p }, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia: async () => {} },
    compute: { probeMedia: async () => '{}', hashMediaSource: async () => HASH, parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
    enqueueWorkspaceCopy: async () => {},
    readFile: (p: string) => memFs.readFile(p),
    statPath: () => ({ kind: 'file' as const, readable: true }),
    workspaceDir: () => wsDir,
  })
  const fsCalls = () => poolFs.stat.mock.calls.length + poolFs.statAsync.mock.calls.length
  const changes = () => sent.filter((s) => s.event === 'project:changed').length
  return { host, disk, poolFs, fsCalls, changes }
}

/** A proxied clip whose source, proxies and conform are all on disk. */
function addClip(t: ReturnType<typeof makeHost>, n: number): MediaItem {
  const id = `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`
  const files = { src: `/p/Media/${n}.mp4`, quick: `/p/Cache/q${n}.mp4`, full: `/p/Cache/f${n}.mp4`, conform: `/p/Cache/${n}.conform` }
  for (const p of Object.values(files)) t.disk.set(p, FILE)
  const item: MediaItem = {
    ...mediaItemTemplate(id, 'Video', 4_000_000), path_abs: files.src, file_hash_blake3: HASH, file_size: FILE.size, file_mtime: FILE.mtimeSecs,
    decode_route: { route: 'proxied', quick_proxy: files.quick, full_proxy: files.full, format_version: 1 }, conform_path: files.conform,
  }
  expect(t.host.actor.dispatch('add_media_item', { media: item }).ok).toBe(true)
  return item
}

const shown = (t: ReturnType<typeof makeHost>, id: string) => t.host.publication().summary!.media.find((m) => m.id === id)!

async function openWithClips() {
  const t = makeHost()
  t.host.start()
  await t.host.handleInvoke('project_new_workspace', { parentFolder: '/projects', name: 'Files', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
  const clips = [addClip(t, 1), addClip(t, 2), addClip(t, 3)]
  const track = t.host.actor.snapshot().compositions[t.host.actor.snapshot().root_id]!.tracks[0]!.id
  const layer = await t.host.handleInvoke('add_media_layer', { trackId: track, tStartUs: 0, mediaId: clips[0]!.id }) as string
  await t.host.handleInvoke('project_publication', {})
  return { ...t, clips, track, layer }
}

describe('pool files on the publication path', () => {
  it('an edit that touches no media reads no file', async () => {
    const t = await openWithClips()
    expect(shown(t, t.clips[0]!.id)).toMatchObject({ available: true, conform_path: t.clips[0]!.conform_path })
    const before = t.fsCalls()
    const revision = t.host.publication().version.revision
    const edits: Array<[string, Record<string, unknown>]> = [
      ['move_layer', { layerId: t.layer, newTrackId: t.track, newTStartUs: 1_000_000 }],
      ['add_track', {}],
      ['add_marker', { tUs: 500_000 }],
      ['project_undo', {}],
      ['project_redo', {}],
    ]
    for (const [channel, args] of edits) {
      await t.host.handleInvoke(channel, args)
      await t.host.handleInvoke('project_publication', {})
    }
    expect(t.host.publication().version.revision).toBeGreaterThanOrEqual(revision + edits.length)
    expect(t.fsCalls()).toBe(before)
    t.host.stop()
  })

  it('a derivative deleted outside reads as not ready once the window is back, with no edit', async () => {
    const t = await openWithClips()
    const clip = t.clips[1]!
    const route = clip.decode_route as { quick_proxy: string; full_proxy: string }
    t.disk.delete(route.quick_proxy)
    t.disk.delete(clip.conform_path!)
    const changes = t.changes()
    await t.host.poolFiles.refresh()
    expect(t.changes()).toBe(changes + 1)
    expect(shown(t, clip.id)).toMatchObject({
      available: true, conform_path: null,
      decode_route: { route: 'proxied', quick_proxy: null, full_proxy: route.full_proxy },
    })

    // Made again outside: present after the next focus.
    t.disk.set(route.quick_proxy, FILE)
    await t.host.poolFiles.refresh()
    expect(t.changes()).toBe(changes + 2)
    expect(shown(t, clip.id).decode_route).toMatchObject({ quick_proxy: route.quick_proxy })
    t.host.stop()
  })

  it('a focus that finds nothing changed publishes nothing', async () => {
    const t = await openWithClips()
    const changes = t.changes()
    await t.host.poolFiles.refresh()
    expect(t.changes()).toBe(changes)
    t.host.stop()
  })

  it('a source deleted outside is unavailable after focus', async () => {
    const t = await openWithClips()
    t.disk.delete(t.clips[2]!.path_abs)
    await t.host.poolFiles.refresh()
    expect(shown(t, t.clips[2]!.id).available).toBe(false)
    t.host.stop()
  })

  it('a job writing back a proxy is shown without a focus, also at a path read missing before', async () => {
    const t = await openWithClips()
    const clip = t.clips[0]!
    const fresh = '/p/Cache/q1-v2.mp4'
    t.disk.set(fresh, FILE)
    expect(applyDerivativesEvent(t.host.actor, { media_id: clip.id, patch: { quick_proxy_landed: fresh } }).ok).toBe(true)
    expect(shown(t, clip.id).decode_route).toMatchObject({ quick_proxy: fresh })

    // Deleted outside and noticed, then made again by a job at the same path.
    t.disk.delete(fresh)
    await t.host.poolFiles.refresh()
    expect(shown(t, clip.id).decode_route).toMatchObject({ quick_proxy: null })
    t.disk.set(fresh, FILE)
    expect(applyDerivativesEvent(t.host.actor, { media_id: clip.id, patch: { quick_proxy_landed: fresh } }).ok).toBe(true)
    expect(shown(t, clip.id).decode_route).toMatchObject({ quick_proxy: fresh })
    t.host.stop()
  })

  it('a file a failed job removed is shown on its recheck', async () => {
    const t = await openWithClips()
    const clip = t.clips[0]!
    t.disk.delete(clip.conform_path!)
    const changes = t.changes()
    t.host.poolFiles.recheck(clip.id)
    expect(t.changes()).toBe(changes + 1)
    expect(shown(t, clip.id).conform_path).toBeNull()
    t.host.stop()
  })

  it('the summary an export starts from reads every file again, and republishes what moved', async () => {
    const t = await openWithClips()
    const clip = t.clips[1]!
    const full = (clip.decode_route as { full_proxy: string }).full_proxy
    t.disk.delete(full)
    const changes = t.changes()
    const summary = await t.host.handleInvoke('project_summary', {}) as { media: Array<{ id: string; decode_route: { full_proxy: string | null } }> }
    expect(summary.media.find((m) => m.id === clip.id)!.decode_route.full_proxy).toBeNull()
    expect(t.changes()).toBe(changes + 1)
    expect(shown(t, clip.id).decode_route).toMatchObject({ full_proxy: null })
    t.host.stop()
  })

  it('a workspace replacement forgets every file read', async () => {
    const t = await openWithClips()
    await t.host.handleInvoke('project_save_as', { path: '/projects/Copy' })
    const before = t.fsCalls()
    t.host.publication()
    expect(t.poolFs.stat.mock.calls.slice(before).map(([p]) => p)).toEqual(expect.arrayContaining(t.clips.map((c) => c.path_abs)))
    t.host.stop()
  })
})
