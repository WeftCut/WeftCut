// apps/desktop/src/main/state/__tests__/project-folder.test.ts
//
// A project folder opens wherever it lands: its media are found in it by
// project path, its cached derivatives are ready before the project shows,
// and Save As carries the folder's content to the new one, the open project
// following it there with its undo history intact.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createTsActorHost, type TsActorHostDeps } from '../ts-actor-host'
import type { PackNative } from '../projectPack'
import { PROJECT_OPENED_EVENT } from '../../../shared/project-events'
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
  disk.put(`${dir}/project.wcpr`, JSON.stringify(wire))
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
  it('leaves no project.wcpr and commits nothing when a file cannot be copied', async () => {
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
    expect(disk.fs.exists('/projects/Copy/project.wcpr')).toBe(false)
    expect(commitWorkspace).not.toHaveBeenCalled()
  })
})

describe('the open project in its folder (host)', () => {
  function makeHost(disk: MemDisk, patches: (dir: string) => Record<string, MediaDerivativesPatch> = () => ({}), extra: Partial<TsActorHostDeps> = {}) {
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
      ...extra,
    })
    host.start()
    return { host, hashMediaSource, enqueueJobsForMedia, sent }
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

  it('the check dialog reads the host\'s report, and its folder cleanup refuses with no project open', async () => {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6())
    disk.fs.rm('/projects/Demo/Media/sub/clip.mp4')
    const t = makeHost(disk)
    await expect(t.host.handleInvoke('project_trash_motif_folder', { name: 'spare' })).rejects.toThrow(/No project is open/)
    await t.host.handleInvoke('project_open', { path: '/projects/Demo' })
    expect(await t.host.handleInvoke('project_portability', {})).toEqual(t.host.portability())
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

  /** The native pack commands over the memory disk: a pack is the listed
   *  files' bytes and times, held by archive path. */
  function memPacks(disk: MemDisk) {
    const packs = new Map<string, { schema: number; files: { path: string; data: string; mtimeMs: number }[] }>()
    const calls: { cmd: string; args: Record<string, any>; projectJson?: string }[] = []
    const native: PackNative = {
      invoke: async (cmd, json) => {
        const args = JSON.parse(json) as Record<string, any>
        if (cmd === 'project_pack') {
          calls.push({ cmd, args, projectJson: disk.read(`${args.folder}/project.wcpr`) })
          packs.set(args.archive, { schema: args.schemaVersion, files: (args.files as string[]).map((f) => ({ path: f, data: disk.read(`${args.folder}/${f}`)!, mtimeMs: disk.mtimeMs(`${args.folder}/${f}`)! })) })
          return JSON.stringify({ files: args.files.length })
        }
        calls.push({ cmd, args })
        const pack = packs.get(args.archive)
        if (!pack) throw new Error('No such file or directory (os error 2)')
        if (cmd === 'project_pack_inspect') {
          return JSON.stringify({ manifest: { files: pack.files }, project_json: pack.files.find((f) => f.path === 'project.wcpr')!.data, total_bytes: pack.files.reduce((n, f) => n + f.data.length, 0) })
        }
        for (const f of pack.files) disk.put(`${args.folder}/${f.path}`, f.data, f.mtimeMs / 1000)
        return JSON.stringify({ files: pack.files.length })
      },
      cancelComputeJob: () => false,
    }
    return { native, calls }
  }

  it('packs the open project with its unsaved edits, and the unpacked folder opens with the same media and layers', async () => {
    const disk = memDisk()
    folder(disk, '/projects/Demo', windowsV6())
    disk.put('/projects/Demo/Cache/proxies/old.mp4', 'machine-local')
    const packs = memPacks(disk)
    const t = makeHost(disk, () => ({}), { packNative: packs.native, appVersion: '1.2.3' })
    await t.host.handleInvoke('project_open', { path: '/projects/Demo' })
    await t.host.handleInvoke('add_track', {})
    const tracks = (h: typeof t) => Object.values(h.host.actor.snapshot().compositions).reduce((n, c) => n + c.tracks.length, 0)
    const packed = tracks(t)
    await expect(t.host.handleInvoke('project_pack', { archive: '/out/Demo.wcpk' })).resolves.toMatchObject({ outcome: 'done' })
    const pack = packs.calls.find((c) => c.cmd === 'project_pack')!
    const packedTracks = Object.values(JSON.parse(pack.projectJson!).compositions as Record<string, { tracks: unknown[] }>).reduce((n, c) => n + c.tracks.length, 0)
    expect(packedTracks, 'the pack holds the track not yet autosaved').toBe(packed)
    expect(pack.args.files).toEqual(['project.wcpr', 'Media/sub/clip.mp4'])
    t.host.stop()

    const elsewhere = makeHost(disk, () => ({}), { packNative: packs.native })
    await expect(elsewhere.host.handleInvoke('project_unpack', { archive: '/out/Demo.wcpk', parent: '/elsewhere' }))
      .resolves.toEqual({ outcome: 'done', dir: '/elsewhere/Demo' })
    expect(elsewhere.host.openedProject()).toEqual({ dir: '/elsewhere/Demo' })
    expect(elsewhere.sent.map((e) => e.event)).toContain(PROJECT_OPENED_EVENT)
    expect(tracks(elsewhere)).toBe(packed)
    expect(media(elsewhere).map((m) => [m.path, m.available])).toEqual([['/elsewhere/Demo/Media/sub/clip.mp4', true]])
    expect(disk.read('/elsewhere/Demo/.gitignore')).toBe(DEFAULT_GITIGNORE)
    expect(disk.fs.exists('/elsewhere/Demo/Cache/proxies/old.mp4')).toBe(false)
    elsewhere.host.stop()
  })
})
