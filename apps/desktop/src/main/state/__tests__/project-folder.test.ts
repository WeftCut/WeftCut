// apps/desktop/src/main/state/__tests__/project-folder.test.ts
//
// A project folder opens wherever it lands: its media are found in it by
// project path, its cached derivatives are ready before the project shows,
// and Save As carries the folder's content to the new one, the open project
// following it there with its undo history intact.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createTsActorHost } from '../ts-actor-host'
import { openProject, saveProjectAs, type OrchestratorDeps, type SchemaUpgradeReport, type WorkspaceNapi } from '../workspace-orchestrator'
import { DEFAULT_GITIGNORE } from '../projectContent'
import type { MediaDerivativesPatch } from '../mutations/media'
import type { MediaItem, Project } from '../model'
import { blankProject } from '../model'
import { seededGen } from '../ids'
import { memDisk, type MemDisk } from './fixtures/memDisk'

const MEDIA_ID = '00000000-0000-0000-0000-0000000000aa'
const VOICE_HASH = 'b'.repeat(64)
const VOICE_ID = '00000000-0000-0000-0000-0000000000bb'

/** The v6 fixture as Windows wrote it: backslashes in the project path, the
 *  absolute path of the folder on that machine. */
function windowsV6(opts: { voiceover?: boolean } = {}): Record<string, any> {
  const wire = JSON.parse(readFileSync('fixtures/projects/v6.json', 'utf8'))
  const item = wire.media_pool[MEDIA_ID]
  item.path_rel = 'Media\\sub\\clip.mp4'
  item.path_abs = 'C:\\Users\\u\\Videos\\Demo.vproj\\Media\\sub\\clip.mp4'
  if (opts.voiceover) {
    wire.media_pool[VOICE_ID] = { ...structuredClone(item), id: VOICE_ID, kind: 'Audio', path_rel: null,
      path_abs: `C:\\Users\\u\\Videos\\Demo.vproj\\Cache\\voiceover\\${VOICE_HASH}.mp3`, file_hash_blake3: VOICE_HASH,
      decode_route: { route: 'bypass' } }
  }
  return wire
}

/** A folder at `dir` holding `wire` and the clip at the size and time it records. */
function folder(disk: MemDisk, dir: string, wire: Record<string, any>): void {
  disk.put(`${dir}/project.json`, JSON.stringify(wire))
  const item = wire.media_pool[MEDIA_ID]
  disk.put(`${dir}/Media/sub/clip.mp4`, 'c'.repeat(item.file_size), item.file_mtime)
}

describe('openProject — a folder written on another OS', () => {
  function harness(disk: MemDisk, patches: Record<string, MediaDerivativesPatch> = {}) {
    const calls: string[] = []
    const swapped: Project[] = []
    const reports: SchemaUpgradeReport[] = []
    const hydrated: MediaItem[][] = []
    const napi: WorkspaceNapi = {
      commitWorkspace: vi.fn(async () => { calls.push('commit') }),
      pushRecent: vi.fn(() => {}),
      setLastNewProjectParent: vi.fn(() => {}),
      enqueueJobsForMedia: vi.fn(() => {}),
      hydrateDerivatives: vi.fn(async (json: string) => { calls.push('hydrate'); hydrated.push(JSON.parse(json)); return JSON.stringify(patches) }),
    }
    const contentFs = { ...disk.contentFs, copyFile: async (src: string, dst: string, mode?: number) => { calls.push('plan'); return disk.contentFs.copyFile(src, dst, mode) } }
    const deps: OrchestratorDeps = {
      actor: { replaceState: vi.fn((p: Project) => { calls.push('replaceState'); swapped.push(p) }), snapshot: vi.fn(), dispatch: vi.fn() },
      napi, fs: disk.fs, join: (...p: string[]) => p.join('/'), idGen: seededGen(), platform: 'linux', contentFs,
      enqueueDerivatives: () => { calls.push('enqueue') },
      onSchemaUpgrade: (r) => { reports.push(r) },
    }
    return { deps, calls, swapped, reports, hydrated }
  }

  it('places every item under the folder', async () => {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6())
    const h = harness(disk)
    await openProject(h.deps, '/projects/Demo')
    const pool = Object.values(h.swapped[0]!.media_pool)
    expect(pool.map(m => m.path_abs)).toEqual(['/projects/Demo/Media/sub/clip.mp4'])
    expect(pool.map(m => m.path_rel)).toEqual(['Media/sub/clip.mp4'])
  })

  it('carries out the upgrade\'s file plans, then reads the cache, then shows the project, then starts jobs', async () => {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6({ voiceover: true }))
    disk.put(`/projects/Demo/Cache/voiceover/${VOICE_HASH}.mp3`, 'voice')
    const h = harness(disk)
    await openProject(h.deps, '/projects/Demo')
    expect(h.calls.filter(c => c !== 'commit')).toEqual(['plan', 'hydrate', 'replaceState', 'enqueue'])
    const voice = h.swapped[0]!.media_pool[VOICE_ID]!
    expect(disk.read(voice.path_abs)).toBe('voice')
    expect(h.reports[0]!.missingMedia).toBeUndefined()
  })

  it('reports a voiceover the upgrade could not copy', async () => {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6({ voiceover: true }))
    const h = harness(disk)
    await openProject(h.deps, '/projects/Demo')
    const voice = h.swapped[0]!.media_pool[VOICE_ID]!
    expect(h.reports[0]!.missingMedia?.map(m => m.path)).toEqual([voice.path_rel])
  })

  it('shows the cached derivatives in the state it installs, asking only for items with a real hash', async () => {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6({ voiceover: true }))
    const wave = '/projects/Demo/Cache/waveforms/clip.json'
    const h = harness(disk, { [MEDIA_ID]: { waveform_path: wave, full_proxy_landed: '/projects/Demo/Cache/proxies/clip.mp4' } })
    await openProject(h.deps, '/projects/Demo')
    const item = h.swapped[0]!.media_pool[MEDIA_ID]!
    expect(item.waveform_path).toBe(wave)
    expect(item.decode_route).toMatchObject({ route: 'proxied', full_proxy: '/projects/Demo/Cache/proxies/clip.mp4' })
    // The runtime item, its path in this folder; the voiceover is still pending.
    expect(h.hydrated[0]!.map(m => [m.id, m.path_abs])).toEqual([[MEDIA_ID, '/projects/Demo/Media/sub/clip.mp4']])
  })

  it('opens with nothing ready when the cache cannot be read', async () => {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6())
    const h = harness(disk)
    h.deps.napi.hydrateDerivatives = vi.fn(async () => { throw new Error('generation moved') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await openProject(h.deps, '/projects/Demo')
    expect(h.swapped[0]!.media_pool[MEDIA_ID]!.waveform_path).toBeNull()
    expect(h.calls).toContain('enqueue')
  })
})

describe('saveProjectAs — the content goes first', () => {
  it('leaves no project.json and commits nothing when a file cannot be copied', async () => {
    const disk = memDisk()
    disk.put('/projects/Demo/Media/clip.mp4', 'clip')
    disk.refuse.clone = 'ENOTSUP'
    disk.refuse.link = 'EXDEV'
    disk.refuse.copy = () => 'ENOSPC'
    const commitWorkspace = vi.fn(async () => {})
    const deps: OrchestratorDeps = {
      actor: { replaceState: vi.fn(), snapshot: () => blankProject(seededGen(), 'Demo'), dispatch: vi.fn() },
      napi: { commitWorkspace, pushRecent: vi.fn(), setLastNewProjectParent: vi.fn(), enqueueJobsForMedia: vi.fn() },
      fs: disk.fs, join: (...p: string[]) => p.join('/'), idGen: seededGen(), contentFs: disk.contentFs, platform: 'linux',
    }
    await expect(saveProjectAs(deps, '/projects/Copy', '/projects/Demo')).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(disk.fs.exists('/projects/Copy/project.json')).toBe(false)
    expect(commitWorkspace).not.toHaveBeenCalled()
  })
})

describe('the open project in its folder (host)', () => {
  function makeHost(disk: MemDisk, patches: (dir: string) => Record<string, MediaDerivativesPatch> = () => ({})) {
    let wsDir: string | null = null
    const sent: { event: string; payload: unknown }[] = []
    const hashMediaSource = vi.fn(async () => 'f'.repeat(64))
    const enqueueJobsForMedia = vi.fn(async () => {})
    const host = createTsActorHost({
      send: (event, payload) => { sent.push({ event, payload }) },
      poolFs: disk.poolFs,
      fs: disk.fs,
      contentFs: disk.contentFs,
      platform: 'linux',
      join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      napi: {
        commitWorkspace: async (p: string) => { wsDir = p }, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia,
        hydrateDerivatives: async () => JSON.stringify(patches(wsDir!)),
      },
      compute: { probeMedia: async () => '{}', hashMediaSource, parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
      enqueueWorkspaceCopy: async () => {},
      readFile: (p: string) => disk.fs.readFile(p),
      statPath: () => ({ kind: 'file' as const, readable: true }),
      workspaceDir: () => wsDir,
    })
    host.start()
    return { host, hashMediaSource, enqueueJobsForMedia }
  }
  const media = (t: ReturnType<typeof makeHost>) => t.host.publication().summary!.media

  it('finds every file of a Windows-written folder without reading one', async () => {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6())
    const t = makeHost(disk)
    await t.host.handleInvoke('project_open', { path: '/projects/Demo' })
    expect(Object.values(t.host.actor.snapshot().media_pool).map(m => m.path_abs)).toEqual(['/projects/Demo/Media/sub/clip.mp4'])
    expect(media(t).map(m => m.available)).toEqual([true])
    // The re-fan-out goes once the file is settled, which is when a read would have run.
    await vi.waitFor(() => expect(t.enqueueJobsForMedia).toHaveBeenCalled())
    expect(t.hashMediaSource).not.toHaveBeenCalled()
    t.host.stop()
  })

  it('publishes the cached derivatives with the opened project', async () => {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6())
    const proxy = '/projects/Demo/Cache/proxies/clip.full-p8.mp4'
    disk.put(proxy, 'proxy')
    const t = makeHost(disk, () => ({ [MEDIA_ID]: { full_proxy_landed: proxy } }))
    await t.host.handleInvoke('project_open', { path: '/projects/Demo' })
    expect(media(t)[0]!.decode_route).toMatchObject({ route: 'proxied', full_proxy: proxy })
    t.host.stop()
  })

  it('the portability check finds a complete folder portable, and nothing to check on the start screen', async () => {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6())
    const t = makeHost(disk)
    expect(t.host.portability()).toBeNull()
    await t.host.handleInvoke('project_open', { path: '/projects/Demo' })
    expect(t.host.portability()).toMatchObject({ portable: true, media: { outside: [], missing: [] } })
    t.host.stop()
  })

  it('the portability check lists a pooled file the folder no longer holds', async () => {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6())
    disk.fs.rm('/projects/Demo/Media/sub/clip.mp4')
    const t = makeHost(disk)
    await t.host.handleInvoke('project_open', { path: '/projects/Demo' })
    expect(t.host.portability()).toMatchObject({ portable: false, media: { missing: [{ media_id: MEDIA_ID }], outside: [] } })
    t.host.stop()
  })

  async function savedAs() {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6())
    disk.put('/projects/Demo/TASTE.md', 'taste')
    disk.put('/projects/Demo/Cache/proxies/old.mp4', 'old proxy')
    const fresh = '/projects/Copy/Cache/waveforms/clip.json'
    const t = makeHost(disk, (dir) => (dir === '/projects/Copy' ? { [MEDIA_ID]: { waveform_path: fresh } } : {
      [MEDIA_ID]: { waveform_path: '/projects/Demo/Cache/waveforms/clip.json', full_proxy_landed: '/projects/Demo/Cache/proxies/old.mp4' },
    }))
    await t.host.handleInvoke('project_open', { path: '/projects/Demo' })
    const tracks = () => Object.values(t.host.actor.snapshot().compositions).reduce((n, c) => n + c.tracks.length, 0)
    const before = tracks()
    await t.host.handleInvoke('add_track', {})
    await t.host.handleInvoke('project_save_as', { path: '/projects/Copy' })
    return { disk, t, tracks, before, fresh }
  }

  it('after Save As every item is in the new folder, with the new cache\'s derivatives only', async () => {
    const { t, fresh } = await savedAs()
    const item = t.host.actor.snapshot().media_pool[MEDIA_ID]!
    expect(item.path_abs).toBe('/projects/Copy/Media/sub/clip.mp4')
    expect(item.waveform_path).toBe(fresh)
    expect(item.decode_route).toMatchObject({ full_proxy: null })
    t.host.stop()
  })

  it('Save As keeps the undo history, and an undone state names the new folder too', async () => {
    const { t, tracks, before } = await savedAs()
    await t.host.handleInvoke('project_undo', {})
    expect(tracks()).toBe(before)
    expect(t.host.actor.snapshot().media_pool[MEDIA_ID]!.path_abs).toBe('/projects/Copy/Media/sub/clip.mp4')
    t.host.stop()
  })

  it('the saved copy reopens with every item found', async () => {
    const { disk, t } = await savedAs()
    expect(disk.read('/projects/Copy/TASTE.md')).toBe('taste')
    expect(disk.fs.exists('/projects/Copy/Cache/proxies/old.mp4')).toBe(false)
    // The source had no .gitignore, so the copy gets the default.
    expect(disk.read('/projects/Copy/.gitignore')).toBe(DEFAULT_GITIGNORE)
    t.host.stop()
    const reopened = makeHost(disk)
    await reopened.host.handleInvoke('project_open', { path: '/projects/Copy' })
    expect(media(reopened).map(m => [m.path, m.available])).toEqual([['/projects/Copy/Media/sub/clip.mp4', true]])
    await vi.waitFor(() => expect(reopened.enqueueJobsForMedia).toHaveBeenCalled())
    expect(reopened.hashMediaSource).not.toHaveBeenCalled()
    reopened.host.stop()
  })
})
