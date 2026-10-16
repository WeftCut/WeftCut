import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { mapChangeEvent, createTsActorHost } from './ts-actor-host'
import { UserMotifStore } from '../motif/store'
import { createAppSettingsStore } from '../app-settings'
import { createViewStateStore } from '../view-state'
import { viewStateDefaults, type ViewState } from '../../shared/view-state'
import { createExportSettingsStore } from '../export-settings'
import { createKeybindingsStore } from '../keybindings'
import { createRecentsStore } from '../recents'
import { createWorkspaceStore } from '../workspace'
import { EDITING_WORKSPACE_ID, activeWorkspaceProfile, type WorkspaceDocument } from '../../shared/workspace'
import { root } from './__tests__/fixtures/project'
import { DEFAULT_CAPTION_FONT_FAMILY } from '../../shared/fonts'
import { EDIT_TRACE_ARG, EDIT_TRACE_PREFIX } from '../../shared/editTrace'
import { applyDerivativesEvent } from './jobs-writeback'
import { ExportJobs } from '../exportJobs'

describe('mapChangeEvent', () => {
  it('maps a User ChangeEvent to the project:changed payload shape, refs included', () => {
    const out = mapChangeEvent({ op_id: 'op-1', actor: { kind: 'User' }, timestamp: '2026-06-23T00:00:00.000Z', summary: 'Added clip', affected: [{ kind: 'Layer', id: 'L1' }], new_snapshot: {} as never, diff_hint: { kind: 'Coarse' } })
    expect(out).toEqual({ op_id: 'op-1', actor_kind: 'user', client: null, summary: 'Added clip', timestamp: '2026-06-23T00:00:00.000Z', affected: [{ kind: 'Layer', id: 'L1' }] })
  })
  it('maps an Agent ChangeEvent client through', () => {
    const out = mapChangeEvent({ op_id: 'op-2', actor: { kind: 'Agent', client: 'mcp' }, timestamp: 't', summary: 's', affected: [], new_snapshot: {} as never, diff_hint: { kind: 'Coarse' } })
    expect(out.actor_kind).toBe('agent'); expect(out.client).toBe('mcp')
  })
})

describe('createTsActorHost — persistence-route integration', () => {
  function makeInMemoryDeps() {
    // In-memory filesystem: path → content string.
    const vfs: Record<string, string> = {}
    const dirsMade = new Set<string>()

    const memFs = {
      exists: (p: string) => Object.prototype.hasOwnProperty.call(vfs, p) || dirsMade.has(p),
      readFile: (p: string) => {
        if (!Object.prototype.hasOwnProperty.call(vfs, p)) throw new Error(`vfs: file not found: ${p}`)
        return vfs[p]!
      },
      writeFile: (p: string, t: string) => { vfs[p] = t },
      rename: (a: string, b: string) => { vfs[b] = vfs[a]!; delete vfs[a] },
      mkdirp: (d: string) => { dirsMade.add(d) },
      copyFile: (s: string, d: string) => { vfs[d] = vfs[s]! },
      readdir: (d: string) => Object.keys(vfs).filter((k) => k.startsWith(d + '/') && k.slice(d.length + 1).indexOf('/') === -1).map((k) => k.slice(d.length + 1)),
      rm: (p: string) => { delete vfs[p] },
    }

    // Workspace dir tracking — commitWorkspace updates this.
    let wsDir: string | null = null
    const napiCalls: { method: string; args: unknown[] }[] = []

    const memNapi = {
      commitWorkspace: async (p: string) => { wsDir = p; napiCalls.push({ method: 'commitWorkspace', args: [p] }) },
      endWorkspace: async () => { wsDir = null },
      pushRecent: (_p: string, _n: string) => { napiCalls.push({ method: 'pushRecent', args: [_p, _n] }) },
      setLastNewProjectParent: (_p: string) => { napiCalls.push({ method: 'setLastNewProjectParent', args: [_p] }) },
      enqueueJobsForMedia: async (_j: string) => { napiCalls.push({ method: 'enqueueJobsForMedia', args: [_j] }) },
    }

    const sent: { event: string; payload: unknown }[] = []

    const deps = {
      send: (event: string, payload: unknown) => { sent.push({ event, payload }) },
      mcpNotify: () => {},
      fileExists: (p: string) => memFs.exists(p),
      fs: memFs,
      join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
      napi: memNapi,
      compute: { probeMedia: async () => '{}', hashMediaSource: async () => 'h', parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
      enqueueWorkspaceCopy: async () => {},
      readFile: (p: string) => memFs.readFile(p),
      statPath: () => ({ kind: 'file' as const, readable: true }),
      workspaceDir: () => wsDir,
      appSettings: createAppSettingsStore({ fs: memFs, path: '/cfg/app_settings.json', dir: '/cfg' }),
      viewState: createViewStateStore({ fs: memFs, join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/') }),
      exportSettings: createExportSettingsStore({ fs: memFs, join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/') }),
      keybindings: createKeybindingsStore({ fs: memFs, path: '/cfg/keybindings.json', dir: '/cfg' }),
      recents: createRecentsStore({ fs: memFs, path: '/cfg/recents.json', dir: '/cfg' }),
      // debounceMs 0 + immediate timer → writes land synchronously in tests.
      workspace: createWorkspaceStore({ fs: memFs, path: '/cfg/workspaces.json', dir: '/cfg', debounceMs: 0, timer: { set: (cb: () => void) => { cb(); return null }, clear: () => {} } }),
    }

    return { deps, vfs, napiCalls, sent }
  }

  const publicationProject = { parentFolder: '/projects', name: 'Publication', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }

  function makeExportSessionHost() {
    const fixture = makeInMemoryDeps()
    const sessions: Array<ReturnType<ExportJobs['rendererSession']>> = []
    const jobs = new ExportJobs({
      host: () => host,
      native: async () => null,
      send: event => {
        // The renderer responds to this event by querying and announcing its
        // session. Exercise that handshake against the real lifecycle owner.
        if (event !== 'export:session_ready') return
        const session = jobs.rendererSession()
        jobs.rendererReady('renderer', session.root_id, session.generation)
        sessions.push(session)
      },
    })
    const host = createTsActorHost({ ...fixture.deps, exportJobs: jobs,
      onWorkspaceChanging: () => jobs.forgetRenderer(),
    })
    return { ...fixture, host, jobs, sessions }
  }

  it('saves and closes without requesting an export session, then restores readiness on reopen and Save As', async () => {
    const { host, sessions, vfs } = makeExportSessionHost()
    host.start()
    try {
      const dir = await host.handleInvoke('project_new_workspace', publicationProject)
      expect(sessions).toHaveLength(1)
      const marker = await host.handleInvoke('add_marker', { tUs: 1_000_000 })
      await host.published(() => host.handleInvoke('project_close', {}))
      expect(host.openedProject()).toBeNull()
      expect(host.publication().summary).toBeNull()
      expect(sessions).toHaveLength(1)
      const saved = JSON.parse(vfs[`${dir}/project.json`]!)
      expect(saved.compositions[saved.root_id].markers).toEqual([expect.objectContaining({ id: marker })])

      await host.handleInvoke('project_open', { path: dir })
      expect(sessions).toHaveLength(2)
      expect(sessions[1]?.root_id).toBe(host.actor.snapshot().root_id)
      await host.handleInvoke('project_save_as', { path: '/projects/Copy' })
      expect(sessions).toHaveLength(3)
      await host.handleInvoke('project_new_workspace', { ...publicationProject, name: 'Next' })
      expect(sessions).toHaveLength(4)
      expect(sessions[3]?.root_id).toBe(host.actor.snapshot().root_id)
      expect(sessions[3]?.root_id).not.toBe(sessions[0]?.root_id)
    } finally { host.stop() }
  })

  it('restores export readiness for the retained project when saving on close fails', async () => {
    const { deps, host, jobs, sessions } = makeExportSessionHost()
    try {
      const dir = await host.handleInvoke('project_new_workspace', publicationProject)
      deps.fs.writeFile = () => { throw new Error('disk full') }
      await expect(host.handleInvoke('project_close', {})).rejects.toThrow('disk full')
      expect(host.openedProject()).toEqual({ dir })
      expect(sessions).toHaveLength(2)
      expect(sessions[1]).toEqual(jobs.rendererSession())
    } finally { host.stop() }
  })

  it('publishes versioned full views and receipts without changing raw results or MCP payloads', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const mcpNotify = vi.fn()
    const host = createTsActorHost({ ...deps, mcpNotify })
    host.start()
    try {
      expect(host.publication()).toEqual({ version: { session: 0, revision: 0 }, summary: null })
      const opened = await host.published(() => host.handleInvoke('project_new_workspace', publicationProject))
      expect(opened.value).toBe('/projects/Publication')
      expect(opened.publication).toEqual({ session: 1, revision: 1 })
      const added = await host.published(() => host.handleInvoke('add_marker', { tUs: 1_000_000 }))
      expect(typeof added.value).toBe('string')
      expect(added.publication).toEqual({ session: 1, revision: 2 })
      const view = host.publication()
      expect(view.version).toEqual(added.publication)
      expect(view.summary?.compositions[view.summary.root_id].markers[0].id).toBe(added.value)
      expect(sent.filter(row => row.event === 'project:changed').at(-1)?.payload).toMatchObject({ publication: added.publication })
      expect(mcpNotify.mock.calls.at(-1)?.[0]).not.toHaveProperty('publication')
      expect(await host.handleInvoke('project_publication', {})).toEqual(view)
      expect(await host.handleInvoke('project_summary', {})).toEqual(view.summary)
      expect(await host.published(() => host.handleInvoke('project_summary', {}))).toEqual({ value: view.summary, publication: null })
      expect((await host.published(() => host.handleInvoke('update_marker', { markerId: added.value, patch: { label: '' } }))).publication).toBeNull()
      const raw = await host.handleInvoke('add_marker', { tUs: 2_000_000 })
      expect(typeof raw).toBe('string')
      const before = host.publication().version
      await expect(host.published(() => host.handleInvoke('update_marker', { id: 'missing', patch: {} }))).rejects.toThrow()
      expect(host.publication().version).toEqual(before)
    } finally { host.stop() }
  })

  it('advances revision for undo, unrecorded preferences and MCP writes, independent of history cursor', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    await host.handleInvoke('project_new_workspace', publicationProject)
    await host.handleInvoke('add_marker', { tUs: 1_000_000 })
    const before = host.publication().version
    expect(host.actor.dispatch('undo', {}).ok).toBe(true)
    expect(host.publication().version).toEqual({ ...before, revision: before.revision + 1 })
    expect(host.actor.dispatch('update_project_settings', { patch: { prefer_proxies: true } }).ok).toBe(true)
    expect(host.publication().version.revision).toBe(before.revision + 2)
    const priorMcp = host.publication().version
    expect(host.mcpCall('add_track', '{}', 'test-agent').ok).toBe(true)
    expect(host.publication().version).toEqual({ ...priorMcp, revision: priorMcp.revision + 1 })
    // A direct whole-state swap also creates a fresh session, even with the
    // same persisted project UUID (reopen is not ordinary undo).
    host.actor.replaceState(host.actor.snapshot())
    expect(host.publication().version.session).toBe(priorMcp.session + 1)
    host.stop()
  })

  it('retains the last settled publication during replacement, then publishes once after opened is updated', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    try {
      await host.handleInvoke('project_new_workspace', publicationProject)
      const old = host.publication()
      let release!: () => void
      const push = deps.napi.pushRecent
      deps.napi.pushRecent = vi.fn(async (...args: Parameters<typeof push>) => {
        push(...args)
        await new Promise<void>(resolve => { release = resolve })
      })
      const count = sent.filter(row => row.event === 'project:changed').length
      const opening = host.published(() => host.handleInvoke('project_new_workspace', { ...publicationProject, name: 'Next' }))
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      expect(host.actor.snapshot().metadata.name).toBe('Next')
      expect(host.publication()).toEqual(old)
      expect(sent.filter(row => row.event === 'project:changed')).toHaveLength(count)
      release()
      const receipt = await opening
      expect(host.publication().summary?.name).toBe('Next')
      expect(host.publication().version).toEqual(receipt.publication)
      expect(receipt.publication?.session).toBe(old.version.session + 1)
      expect(sent.filter(row => row.event === 'project:changed')).toHaveLength(count + 1)
    } finally { host.stop() }
  })

  it('rotates sessions for same-project reopen, Save As and Close, and publishes null only on Close', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    const dir = await host.handleInvoke('project_new_workspace', publicationProject)
    const id = host.publication().summary!.project_id
    await host.handleInvoke('project_open', { path: dir })
    expect(host.publication().version.session).toBe(2)
    expect(host.publication().summary!.project_id).toBe(id)
    await host.handleInvoke('project_save_as', { path: '/projects/Copy' })
    expect(host.publication().version.session).toBe(3)
    const closed = await host.published(() => host.handleInvoke('project_close', {}))
    expect(closed.publication?.session).toBe(4)
    expect(host.publication()).toEqual({ version: closed.publication, summary: null })
    host.stop()
  })

  it('does not invent a session on failed replacement or flush, but reports an actual swap despite later failure', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    await host.handleInvoke('project_new_workspace', publicationProject)
    const old = host.publication()
    await expect(host.handleInvoke('project_open', { path: '/missing' })).rejects.toThrow()
    expect(host.publication()).toEqual(old)
    const write = deps.fs.writeFile
    deps.fs.writeFile = () => { throw new Error('disk full') }
    await expect(host.handleInvoke('project_close', {})).rejects.toThrow('disk full')
    expect(host.publication()).toEqual(old)
    expect(host.openedProject()).toEqual({ dir: '/projects/Publication' })
    deps.fs.writeFile = write
    deps.napi.pushRecent = () => { throw new Error('recent list failed') }
    await expect(host.handleInvoke('project_new_workspace', { ...publicationProject, name: 'Next' })).rejects.toThrow('recent list failed')
    expect(host.publication().summary?.name).toBe('Next')
    expect(host.publication().version.session).toBe(old.version.session + 1)
    expect(host.openedProject()).toEqual({ dir: '/projects/Next' })
    const nextSession = host.publication().version.session
    await expect(host.handleInvoke('project_save_as', { path: '/projects/Copy' })).rejects.toThrow('recent list failed')
    expect(host.publication().version.session).toBe(nextSession + 1)
    expect(host.openedProject()).toEqual({ dir: '/projects/Copy' })
    host.stop()
  })

  it('does not turn projection failures into a closed project or read the projection merely to create a receipt', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    await host.handleInvoke('project_new_workspace', publicationProject)
    const mediaId = '00000000-0000-0000-0000-0000000000aa'
    const base = host.actor.snapshot()
    host.actor.replaceState({ ...base, media_pool: { [mediaId]: {
      id: mediaId, label: null, path_abs: '/clip.mp4', path_rel: 'Media/clip.mp4',
      kind: 'Video', metadata: { duration_us: 1_000_000 }, file_hash_blake3: 'x', file_size: 0, file_mtime: 0,
      imported_at: '2026-01-01T00:00:00Z', decode_route: { route: 'bypass' },
      conform_path: null, waveform_path: null, thumbnails_dir: null,
    } } })
    const beforeJob = host.publication().version
    expect(applyDerivativesEvent(host.actor, { media_id: mediaId, patch: { conform_path: '/conform.wav' } }).ok).toBe(true)
    expect(host.publication().version).toEqual({ ...beforeJob, revision: beforeJob.revision + 1 })
    deps.fileExists = vi.fn(() => { throw new Error('projection failed') })
    const result = await host.published(() => host.handleInvoke('add_marker', { tUs: 1_000_000 }))
    expect(result.publication).not.toBeNull()
    expect(deps.fileExists).not.toHaveBeenCalled()
    await expect(host.handleInvoke('project_publication', {})).rejects.toThrow('projection failed')
    expect(host.openedProject()).not.toBeNull()
    host.stop()
  })

  it('carries edit timing through real command stages and refresh without persisting it', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const id = 'edit-12345678-1234-1234-1234-123456789abc'
    host.start()
    try {
      await host.handleInvoke('add_marker', { tUs: 1_000_000, [EDIT_TRACE_ARG]: id })
      expect(sent.find(row => row.event === 'project:changed')?.payload).toMatchObject({ [EDIT_TRACE_ARG]: id })
      await host.handleInvoke('project_summary', { [EDIT_TRACE_ARG]: id })
      const rows = log.mock.calls.map(([line]) => JSON.parse(String(line).slice(EDIT_TRACE_PREFIX.length + 1)))
      expect(rows.map(row => row.phase)).toEqual(['main.command.add_marker', 'main.summary'])
      expect(rows[0].commandAccepted).toBe(true)
      expect(rows[0].spans.map((span: { stage: string }) => span.stage)).toEqual(expect.arrayContaining([
        'recipe', 'reconcile_markers', 'produce_including_finalize', 'validate', 'notify_subscribers',
      ]))
      expect(JSON.stringify(host.actor.snapshot())).not.toContain(id)
      log.mockClear()
      await host.handleInvoke('add_marker', { tUs: 2_000_000 })
      expect(log).not.toHaveBeenCalled()
      expect(sent.filter(row => row.event === 'project:changed').at(-1)?.payload).not.toHaveProperty(EDIT_TRACE_ARG)
    } finally { host.stop(); log.mockRestore() }
  })

  it('applies the live font preference to UI and MCP text without rewriting existing clips', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    const trackId = root(host.actor.snapshot()).tracks[0].id
    const fonts = () => root(host.actor.snapshot()).tracks.flatMap((t) => t.layers)
      .flatMap((l) => l.params.kind === 'Text' ? [l.params.font.family] : [])
    expect(host.actor.command('add_text_layer', { trackId, tStartUs: 0, durationUs: 1_000_000 }).ok).toBe(true)
    const snapshot = host.actor.snapshot(), history = host.actor.historyStatus()
    await host.handleInvoke('app_settings_set', { patch: { default_text_font: 'Example Sans' } })
    expect(host.actor.snapshot()).toBe(snapshot)
    expect(host.actor.historyStatus()).toEqual(history)
    expect(host.actor.command('add_text_layer', { trackId, tStartUs: 1_000_000, durationUs: 1_000_000 }).ok).toBe(true)
    const spec = { content: 'Title', track_id: trackId, t_start_us: 2_000_000, t_end_us: 3_000_000 }
    expect(host.actor.mcpCall('dry_run', JSON.stringify({ operations: [{ kind: 'add_text_layer', ...spec }] })).ok).toBe(true)
    expect(fonts()).toEqual([DEFAULT_CAPTION_FONT_FAMILY, 'Example Sans'])
    expect(host.actor.mcpCall('add_text_layer', JSON.stringify(spec)).ok).toBe(true)
    await host.handleInvoke('app_settings_set', { patch: { default_text_font: '' } })
    expect(host.actor.command('add_text_layer', { trackId, tStartUs: 3_000_000, durationUs: 1_000_000 }).ok).toBe(true)
    expect(fonts()).toEqual([DEFAULT_CAPTION_FONT_FAMILY, 'Example Sans', 'Example Sans', DEFAULT_CAPTION_FONT_FAMILY])
    host.actor.dispatch('undo', {})
    host.actor.dispatch('redo', {})
    expect(fonts()).toEqual([DEFAULT_CAPTION_FONT_FAMILY, 'Example Sans', 'Example Sans', DEFAULT_CAPTION_FONT_FAMILY])
  })

  it('app settings immediately control cleanup without changing project state or history', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    const idOf = (r: ReturnType<typeof host.actor.dispatch>): string => {
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      return r.value as string
    }
    const track = idOf(host.actor.dispatch('add_track', {}))
    const layer = idOf(host.actor.dispatch('add_layer', { track, kind: 'color', t_start_us: 0, t_end_us: 1_000_000 }))
    const snapshot = host.actor.snapshot(), history = host.actor.historyStatus()
    await host.handleInvoke('app_settings_set', { patch: { auto_delete_empty_tracks: false } })
    expect(host.actor.snapshot()).toBe(snapshot)
    expect(host.actor.historyStatus()).toEqual(history)
    expect(host.actor.dispatch('delete_layers', { layers: [layer] }).ok).toBe(true)
    expect(root(host.actor.snapshot()).tracks.find((t) => t.id === track)?.layers).toEqual([])
    host.actor.dispatch('undo', {})
    await host.handleInvoke('app_settings_set', { patch: { auto_delete_empty_tracks: true } })
    expect(host.actor.dispatch('delete_layers', { layers: [layer] }).ok).toBe(true)
    expect(root(host.actor.snapshot()).tracks.some((t) => t.id === track)).toBe(false)
  })

  it('serializes opening and closing resources even when close arrives during commit', async () => {
    const { deps } = makeInMemoryDeps()
    let release!: () => void
    const entered = vi.fn()
    const commit = deps.napi.commitWorkspace
    deps.napi.commitWorkspace = async p => { entered(); await new Promise<void>(r => { release = r }); await commit(p) }
    const endWorkspace = vi.fn(async () => {})
    const onWorkspaceChanging = vi.fn(), onWorkspaceOpened = vi.fn()
    const host = createTsActorHost({ ...deps, napi: { ...deps.napi, endWorkspace }, onWorkspaceChanging, onWorkspaceOpened })
    const opening = host.handleInvoke('project_new_workspace', {
      parentFolder: '/projects', name: 'pending', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1,
    })
    await vi.waitFor(() => expect(entered).toHaveBeenCalled())
    await expect(host.handleInvoke('import_media', { path: '/source/clip.wav' })).rejects.toThrow(/Project is changing/)
    const closing = host.handleInvoke('project_close', {})
    expect(host.openedProject()).toBeNull()
    expect(endWorkspace).not.toHaveBeenCalled()
    release()
    await Promise.all([opening, closing])
    expect(endWorkspace).toHaveBeenCalledOnce()
    expect(host.openedProject()).toBeNull()
    expect(onWorkspaceChanging.mock.invocationCallOrder.at(-1)).toBeGreaterThan(onWorkspaceOpened.mock.invocationCallOrder.at(-1)!)
    host.stop()
  })

  it('project_open flushes pending edits to the current workspace before switching', async () => {
    vi.useFakeTimers()
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()

    try {
      const targetDir = await host.handleInvoke('project_new_workspace', {
        parentFolder: '/projects',
        name: 'target',
        width: 1920,
        height: 1080,
        fpsNum: 30,
        fpsDen: 1,
      }) as string
      const currentDir = await host.handleInvoke('project_new_workspace', {
        parentFolder: '/projects',
        name: 'current',
        width: 1920,
        height: 1080,
        fpsNum: 30,
        fpsDen: 1,
      }) as string

      await host.handleInvoke('add_track', { kind: 'Video', name: 'Unsaved' })
      await host.handleInvoke('project_open', { path: targetDir })

      const persisted = JSON.parse(vfs[`${currentDir}/project.json`]!) as {
        compositions: Record<string, { tracks: Array<{ label: string | null; role: string | null }> }>; root_id: string
      }
      // The flushed edit is the third track; it stores no label, because a
      // spawned lane's name is derived renderer-side.
      expect(persisted.compositions[persisted.root_id].tracks).toHaveLength(3)
      expect(persisted.compositions[persisted.root_id].tracks.at(-1)).toMatchObject({ label: null, role: null })
      expect(await host.handleInvoke('project_summary', {})).toMatchObject({ name: 'target' })
    } finally {
      host.stop()
      vi.useRealTimers()
    }
  })

  it.each([
    { nextName: 'Example', removeRecent: true, closeFirst: false },
    { nextName: 'Other', removeRecent: true, closeFirst: false },
    { nextName: 'Example', removeRecent: false, closeFirst: false },
    { nextName: 'Example', removeRecent: true, closeFirst: true },
  ])('recreates a deleted workspace while the app stays open: %j', async ({ nextName, removeRecent, closeFirst }) => {
    const parent = mkdtempSync(nodePath.join(tmpdir(), 'weftcut-deleted-project-'))
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost({ ...deps, join: nodePath.join, fs: {
      exists: existsSync,
      readFile: (p) => readFileSync(p, 'utf8'),
      writeFile: (p, text) => writeFileSync(p, text, 'utf8'),
      mkdirp: (p) => { mkdirSync(p, { recursive: true }) },
      copyFile: copyFileSync,
      readdir: readdirSync,
      rm: (p) => rmSync(p, { force: true }),
    } })
    const args = { parentFolder: parent, name: 'Example', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
    try {
      const dir = await host.handleInvoke('project_new_workspace', args) as string
      deps.recents.push(dir, args.name)
      if (closeFirst) await host.handleInvoke('project_close', {})
      // Delete only our generated fixture, never an existing user project.
      expect(nodePath.dirname(dir)).toBe(parent)
      rmSync(dir, { recursive: true })
      if (removeRecent) {
        await host.handleInvoke('recents_remove', { path: dir })
        expect(deps.recents.list()).toEqual([])
      }
      // Explicit Save must not claim that the deleted project was saved.
      if (!closeFirst) await expect(host.handleInvoke('project_save', {})).rejects.toMatchObject({ code: 'ENOENT' })
      const nextDir = nodePath.join(parent, nextName)
      await expect(host.handleInvoke('project_new_workspace', { ...args, name: nextName })).resolves.toBe(nextDir)
      expect(existsSync(nodePath.join(nextDir, 'project.json'))).toBe(true)
    } finally {
      host.stop()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it.each(['EACCES', 'ENOSPC', 'ENOENT'])('keeps save failures blocking replacement when the old directory exists: %s', async (code) => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    const args = { parentFolder: '/projects', name: 'Existing', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 }
    try {
      await host.handleInvoke('project_new_workspace', args)
      const failure = Object.assign(new Error('Cannot save'), { code })
      deps.fs.writeFile = () => { throw failure }
      await expect(host.handleInvoke('project_new_workspace', { ...args, name: 'Next' })).rejects.toBe(failure)
      expect(host.openedProject()).toEqual({ dir: '/projects/Existing' })
      expect(deps.fs.exists('/projects/Next')).toBe(false)
    } finally { host.stop() }
  })

  it('project_new_workspace flushes pending edits to the current workspace before replacing it', async () => {
    vi.useFakeTimers()
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()

    try {
      const currentDir = await host.handleInvoke('project_new_workspace', {
        parentFolder: '/projects',
        name: 'current',
        width: 1920,
        height: 1080,
        fpsNum: 30,
        fpsDen: 1,
      }) as string
      await host.handleInvoke('add_track', {})

      await host.handleInvoke('project_new_workspace', {
        parentFolder: '/projects',
        name: 'replacement',
        width: 1920,
        height: 1080,
        fpsNum: 30,
        fpsDen: 1,
      })

      const persisted = JSON.parse(vfs[`${currentDir}/project.json`]!) as {
        compositions: Record<string, { tracks: Array<{ label: string }> }>; root_id: string
      }
      expect(persisted.compositions[persisted.root_id].tracks).toHaveLength(3)
      expect(await host.handleInvoke('project_summary', {})).toMatchObject({ name: 'replacement' })
    } finally {
      host.stop()
      vi.useRealTimers()
    }
  })

  it('newWorkspace → project_summary → add_track → project_save round-trip', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()

    // 1. Create a new workspace — should write project.json and return the path.
    const wsPath = await host.handleInvoke('project_new_workspace', {
      parentFolder: '/projects',
      name: 'test-proj',
      width: 1920,
      height: 1080,
      fpsNum: 30,
      fpsDen: 1,
    }) as string
    expect(wsPath).toBe('/projects/test-proj')

    // 2. project.json must exist in the vfs at that path.
    const projectFile = '/projects/test-proj/project.json'
    expect(deps.fs.exists(projectFile)).toBe(true)

    // 3. project_summary should reflect the new blank project.
    const summary = await host.handleInvoke('project_summary', {}) as { name: string }
    expect(summary.name).toBe('test-proj')

    // 4. Mutate via add_track — should succeed.
    const addResult = await host.handleInvoke('add_track', { kind: 'Video', name: 'V1' })
    expect(addResult).toBeTruthy()

    // 5. project_save (forceFlush) — should write updated project.json.
    await host.handleInvoke('project_save', {})

    // 6. The written project.json must be valid JSON containing our project name.
    const written = vfs[projectFile]!
    expect(written).toBeDefined()
    const parsed = JSON.parse(written) as { metadata?: { name?: string }; name?: string }
    // The serialized form nests name under metadata (serializeProject shape).
    const projectName = parsed?.metadata?.name ?? (parsed as unknown as { name?: string }).name
    expect(projectName).toBe('test-proj')

    host.stop()
  })

  // The panel's read. Serves the WHOLE stack (limit = the History cap, asked of
  // the actor) — MCP's project://history keeps its own view(100).
  it('project_history_view serves the full stack + checkpoints without dirtying the project', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('project_new_workspace', { parentFolder: '/projects', name: 'hv', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    await host.handleInvoke('add_track', {})
    const cpId = await host.handleInvoke('project_create_checkpoint', { label: 'cp' }) as string

    const before = host.actor.historyStatus()
    const sentBefore = sent.length
    const view = await host.handleInvoke('project_history_view', {}) as {
      ops: Array<{ op_id: string; label_key: string; entity_labels: unknown[] }>
      cursor: number; len: number; evicted: number
      checkpoints: Array<{ id: string; label: string }>
    }

    // Rows the summary channel does not carry at all, plus the eviction counter.
    expect(view.ops).toHaveLength(view.len)
    expect(view.ops[0].label_key).toBe('history.initial')
    expect(view.cursor).toBe(view.len - 1)
    expect(view.evicted).toBe(0)
    expect(view.checkpoints).toEqual([{ id: cpId, label: 'cp', actor: { kind: 'User' }, created_at: expect.any(String) }])

    // A read: no history movement, no change broadcast.
    expect(host.actor.historyStatus()).toEqual(before)
    expect(sent.length).toBe(sentBefore)
    host.stop()
  })

  it('review_view / review_approve / review_approve_all serve the Review baseline and announce review:changed', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    try {
      await host.handleInvoke('project_new_workspace', publicationProject)
      type View = { version: { session: number; revision: number; baseline_revision: number }; has_baseline: boolean; unreviewed: Array<{ id: string }>; user: Array<{ id: string }>; user_count: number }
      type Approved = { applied: boolean; view: View }
      expect(await host.handleInvoke('review_view', {})).toMatchObject({ has_baseline: false, unreviewed: [], user: [] })
      expect(host.mcpCall('add_track', '{}', 'test-agent').ok).toBe(true)
      expect(host.mcpCall('add_track', '{}', 'test-agent').ok).toBe(true)
      await Promise.resolve()
      // Attribution inside two commits: one coalesced notification.
      expect(sent.filter((s) => s.event === 'review:changed')).toHaveLength(1)
      const view = await host.handleInvoke('review_view', {}) as View
      expect(view).toMatchObject({ has_baseline: true, version: { ...host.publication().version } })
      expect(view.unreviewed).toHaveLength(2)
      const before = host.publication().version
      const historyBefore = host.actor.historyStatus()
      const { applied, view: approved } = await host.handleInvoke('review_approve', { version: view.version, change_ids: [view.unreviewed[0].id, 'Layer:stale'] }) as Approved
      expect(applied).toBe(true)
      expect(approved.unreviewed.map((c) => c.id)).toEqual([view.unreviewed[1].id])
      expect(approved.version.baseline_revision).toBeGreaterThan(view.version.baseline_revision)
      host.actor.lockHistory('agent at work')
      expect(await host.handleInvoke('review_approve_all', { version: approved.version })).toMatchObject({ applied: true, view: { unreviewed: [], user: [] } })
      // Approval is not a project write: no publication, no history entry.
      expect(host.publication().version).toEqual(before)
      expect(host.actor.historyStatus()).toEqual({ ...historyBefore, lock_reason: 'agent at work' })
      await Promise.resolve()
      expect(sent.filter((s) => s.event === 'review:changed').at(-1)?.payload).toEqual({ baseline_revision: approved.version.baseline_revision + 1 })
      // Closing accepts silently: nothing to review without an open project.
      expect(host.mcpCall('add_track', '{}', 'test-agent').ok).toBe(true)
      await host.handleInvoke('project_close', {})
      expect(await host.handleInvoke('review_view', {})).toMatchObject({ has_baseline: false, unreviewed: [] })
    } finally { host.stop() }
  })

  it('an approval applies only to the view the user acted on: a commit landing in between approves nothing', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    try {
      await host.handleInvoke('project_new_workspace', publicationProject)
      type View = { version: { session: number; revision: number; baseline_revision: number }; unreviewed: Array<{ id: string; keys: string[] }> }
      type Approved = { applied: boolean; view: View }
      expect(host.mcpCall('add_track', '{}', 'test-agent').ok).toBe(true)
      const seen = await host.handleInvoke('review_view', {}) as View
      expect(seen.unreviewed).toHaveLength(1)
      // The agent commits again between what the user saw and the click.
      expect(host.mcpCall('add_track', '{}', 'test-agent').ok).toBe(true)
      for (const [channel, args] of [['review_approve_all', {}], ['review_approve', { change_ids: [seen.unreviewed[0].id] }]] as const) {
        const r = await host.handleInvoke(channel, { ...args, version: seen.version }) as Approved
        expect(r.applied).toBe(false)
        expect(r.view.unreviewed).toHaveLength(2)
        expect(r.view.version.revision).toBeGreaterThan(seen.version.revision)
      }
      // No version at all is no view the user acted on.
      expect(await host.handleInvoke('review_approve_all', {})).toMatchObject({ applied: false })
      const fresh = await host.handleInvoke('review_view', {}) as View
      expect(fresh.version.baseline_revision).toBe(seen.version.baseline_revision + 1)
      // Against the current view it applies.
      const r = await host.handleInvoke('review_approve', { version: fresh.version, change_ids: [fresh.unreviewed[0].id] }) as Approved
      expect(r).toMatchObject({ applied: true, view: { unreviewed: [{ id: fresh.unreviewed[1].id }] } })
    } finally { host.stop() }
  })

  it('review_view answers a caller holding the current lists with the version alone', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    try {
      await host.handleInvoke('project_new_workspace', publicationProject)
      expect(host.mcpCall('add_track', '{}', 'test-agent').ok).toBe(true)
      type View = { version: unknown; content_revision: number; unreviewed: unknown[] }
      const held = await host.handleInvoke('review_view', {}) as View
      expect(await host.handleInvoke('review_view', { held_content: held.content_revision }))
        .toEqual({ unchanged: true, version: held.version, content_revision: held.content_revision, has_baseline: true, user_count: 0 })
      expect(host.mcpCall('add_track', '{}', 'test-agent').ok).toBe(true)
      const fresh = await host.handleInvoke('review_view', { held_content: held.content_revision }) as View
      expect(fresh.unreviewed).toHaveLength(2)
      expect(fresh.content_revision).toBeGreaterThan(held.content_revision)
    } finally {
      host.stop()
    }
  })

  it('review_view sends the user-only list only when asked, and always its count', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    try {
      await host.handleInvoke('project_new_workspace', publicationProject)
      expect(host.mcpCall('add_track', '{}', 'test-agent').ok).toBe(true)
      expect(host.actor.dispatch('add_track', {}).ok).toBe(true)
      expect(await host.handleInvoke('review_view', {})).toMatchObject({ unreviewed: [{}], user: [], user_count: 1 })
      expect(await host.handleInvoke('review_view', { include_user: true })).toMatchObject({ unreviewed: [{}], user: [{}], user_count: 1 })
    } finally { host.stop() }
  })

  it('review_activity_view serves what one activity\'s ops did, and nothing with no project open', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    try {
      await host.handleInvoke('project_new_workspace', publicationProject)
      expect(host.mcpCall('add_track', '{}', 'test-agent').ok).toBe(true)
      const op = host.actor.historyView(1).ops[0].op_id
      const publication = host.publication().version
      expect(await host.handleInvoke('review_activity_view', { history_ids: [op] }))
        .toMatchObject({ available: true, reverted: false, changes: [{ class: 'added', id: expect.stringMatching(/^Track:/) }] })
      // A read: no publication.
      expect(host.publication().version).toEqual(publication)
      expect(await host.handleInvoke('review_activity_view', { history_ids: ['gone', 3] })).toMatchObject({ available: false, changes: [] })
      expect(await host.handleInvoke('review_activity_view', {})).toMatchObject({ available: false })
      await host.handleInvoke('project_close', {})
      expect(await host.handleInvoke('review_activity_view', { history_ids: [op] })).toMatchObject({ available: false, changes: [] })
    } finally { host.stop() }
  })

  it('project_jump_to moves the cursor through the host and broadcasts project:changed', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('project_new_workspace', { parentFolder: '/projects', name: 'jt', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    await host.handleInvoke('add_track', {})
    await host.handleInvoke('add_track', {})
    const tracksAtHead = root(host.actor.snapshot()).tracks.length

    await host.handleInvoke('project_jump_to', { index: 0 })
    expect(host.actor.historyStatus().cursor).toBe(0)
    expect(root(host.actor.snapshot()).tracks.length).toBe(tracksAtHead - 2)
    expect(sent.filter((s) => s.event === 'project:changed').length).toBeGreaterThan(0)

    // Out of range surfaces as a structured refusal on the IPC rejection.
    await expect(host.handleInvoke('project_jump_to', { index: 99 })).rejects.toThrow(/InvalidArgument/)
    host.stop()
  })

  it('project_save with no workspace is a no-op (workspaceDir returns null)', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    // No workspace set — forceFlush should not throw.
    await expect(host.handleInvoke('project_save', {})).resolves.toBeUndefined()
    host.stop()
  })

  it('handleInvoke routes a motif channel through runMotifTool (open_motif_draft)', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const motifStore = new UserMotifStore(mkdtempSync(nodePath.join(tmpdir(), 'host-motif-')))
    const host = createTsActorHost({ ...deps, motifStore, motifBuiltins: [] })
    host.start()
    const manifest = { id: 'x', name: 'Foo', version: 1, size: [10, 10], default_duration_s: 1, fonts: [], props_schema: {} }
    const {draft_id:id} = await host.handleInvoke('open_motif_draft', { source:{kind:'empty',name:manifest.name} }) as {draft_id:string}
    expect(typeof id).toBe('string')
    expect(motifStore.getDraft(id)).not.toBeNull()
    expect(sent.some((s) => s.event === 'motifs:changed')).toBe(true)
    host.stop()
  })

  it('app_settings_set persists, returns the after-state, and emits app_settings:changed', async () => {
    const { deps, sent } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const after = await host.handleInvoke('app_settings_set', { patch: { display_mode: 'AllTracks' } }) as { display_mode: string }
    expect(after.display_mode).toBe('AllTracks')
    expect(sent.some((s) => s.event === 'app_settings:changed' && (s.payload as { display_mode?: string }).display_mode === 'AllTracks')).toBe(true)
    host.stop()
  })

  it('app_settings_get returns the persisted value', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('app_settings_set', { patch: { tail_snap_strength_px: 20 } })
    const got = await host.handleInvoke('app_settings_get', {}) as { tail_snap_strength_px: number }
    expect(got.tail_snap_strength_px).toBe(20)
    host.stop()
  })

  it('workspace_set_current persists the active profile layout and workspace_get reads it back across a restart', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const layout = { version: 1, empty: false, dockview: { grid: { root: { type: 'leaf', data: { views: ['preview'] } } } } }
    await host.handleInvoke('workspace_set_current', { current: layout })
    expect(vfs['/cfg/workspaces.json']).toBeDefined()
    const got = await host.handleInvoke('workspace_get', {}) as WorkspaceDocument
    expect(got.activeId).toBe(EDITING_WORKSPACE_ID)
    expect(activeWorkspaceProfile(got).current).toEqual(layout)
    expect(activeWorkspaceProfile(got).saved).toBeNull()
    host.stop()

    // A fresh host over the same on-disk document restores the same current.
    const restart = createTsActorHost(deps)
    restart.start()
    const afterRestart = await restart.handleInvoke('workspace_get', {}) as WorkspaceDocument
    expect(activeWorkspaceProfile(afterRestart).current).toEqual(layout)
    restart.stop()
  })

  it('workspace profile CRUD (save-as / switch / save / delete) persists across a restart', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()

    // Save As from the live Editing arrangement → a custom profile becomes active.
    const cutLayout = { version: 1, empty: false, dockview: { grid: { root: { type: 'leaf', data: { views: ['timeline'] } } } } }
    const created = await host.handleInvoke('workspace_create_profile', { name: 'Cutting', current: cutLayout }) as WorkspaceDocument
    expect(created.profiles.map((p) => p.name)).toEqual(['Editing', 'Cutting'])
    const cutId = created.activeId
    expect(cutId).not.toBe(EDITING_WORKSPACE_ID)

    // Edit the custom current, then Save promotes it to the reset baseline.
    await host.handleInvoke('workspace_set_current', { current: { version: 1, empty: true, dockview: null } })
    const saved = await host.handleInvoke('workspace_save_baseline', {}) as WorkspaceDocument
    expect(activeWorkspaceProfile(saved).saved).toEqual({ version: 1, empty: true, dockview: null })

    // Switch back to Editing.
    const switched = await host.handleInvoke('workspace_set_active', { id: EDITING_WORKSPACE_ID }) as WorkspaceDocument
    expect(switched.activeId).toBe(EDITING_WORKSPACE_ID)
    host.stop()

    // Restart: the custom profile + its baseline + the active selection survive.
    const restart = createTsActorHost(deps)
    restart.start()
    const afterRestart = await restart.handleInvoke('workspace_get', {}) as WorkspaceDocument
    expect(afterRestart.activeId).toBe(EDITING_WORKSPACE_ID)
    const cutting = afterRestart.profiles.find((p) => p.id === cutId)!
    expect(cutting.name).toBe('Cutting')
    expect(cutting.saved).toEqual({ version: 1, empty: true, dockview: null })

    // Deleting the custom profile leaves just Editing.
    const deleted = await restart.handleInvoke('workspace_delete_profile', { id: cutId }) as WorkspaceDocument
    expect(deleted.profiles.map((p) => p.id)).toEqual([EDITING_WORKSPACE_ID])
    restart.stop()
  })

  it('workspace_set_current does not dirty the Project or its undo history', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('project_new_workspace', { parentFolder: '/projects', name: 'ws', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    const before = await host.handleInvoke('project_summary', {}) as unknown
    const historyBefore = host.actor.historyStatus()

    await host.handleInvoke('workspace_set_current', { current: { version: 1, empty: true, dockview: null } })

    const after = await host.handleInvoke('project_summary', {}) as unknown
    expect(after).toEqual(before)
    expect(host.actor.historyStatus()).toEqual(historyBefore)
    host.stop()
  })

  it('view_state_set persists to <workspace>/view.json and view_state_get reads it back', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('project_new_workspace', { parentFolder: '/projects', name: 'vs', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    const tabs = [{ composition_id: 'comp-g1', anchor_layer_id: 'ref-g1', px_per_sec: 200, scroll_left_px: 320 }]
    await host.handleInvoke('view_state_set', { state: { composition_tabs: tabs, active_composition_id: 'comp-g1', track_heights: { t1: 64 }, expanded_tracks: ['t1'] } })
    expect(vfs['/projects/vs/view.json']).toBeDefined()
    const got = await host.handleInvoke('view_state_get', {}) as ViewState
    expect(got.composition_tabs).toEqual(tabs)
    expect(got.active_composition_id).toBe('comp-g1')
    expect(got.track_heights.t1).toBe(64)
    expect(got.expanded_tracks).toEqual(['t1'])
    host.stop()
  })

  it('pre-workspace: view_state_get returns defaults and view_state_set is a no-op', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const got = await host.handleInvoke('view_state_get', {}) as ViewState
    expect(got).toEqual(viewStateDefaults())
    await host.handleInvoke('view_state_set', { state: { ...viewStateDefaults(), active_composition_id: 'comp-g1' } })
    expect(Object.keys(vfs).some((k) => k.endsWith('view.json'))).toBe(false)
    host.stop()
  })

  it('export_settings_set persists to <workspace>/export.json and export_settings_get reads it back', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('project_new_workspace', { parentFolder: '/projects', name: 'es', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    const value = { codec: 'av1', quality: 'high', resolution: '1080p' }
    await host.handleInvoke('export_settings_set', { settings: value })
    expect(vfs['/projects/es/export.json']).toBeDefined()
    const got = await host.handleInvoke('export_settings_get', {})
    expect(got).toEqual(value)
    host.stop()
  })

  it('pre-workspace: export_settings_get returns null and export_settings_set is a no-op', async () => {
    const { deps, vfs } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const got = await host.handleInvoke('export_settings_get', {})
    expect(got).toBeNull()
    await host.handleInvoke('export_settings_set', { settings: { codec: 'h264' } })
    expect(Object.keys(vfs).some((k) => k.endsWith('export.json'))).toBe(false)
    host.stop()
  })

  it('keybindings_set persists and keybindings_get reads it back', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('keybindings_set', { action: 'undo', keys: ['Mod+Z', 'F3'] })
    const got = await host.handleInvoke('keybindings_get', {}) as Record<string, string[]>
    expect(got['undo']).toEqual(['Mod+Z', 'F3'])
    host.stop()
  })

  it('keybindings_reset_all clears all overrides', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('keybindings_set', { action: 'undo', keys: ['F3'] })
    await host.handleInvoke('keybindings_reset_all', {})
    const got = await host.handleInvoke('keybindings_get', {}) as Record<string, string[]>
    expect(got).toEqual({})
    host.stop()
  })

  it('keybindings_get returns empty map when no file', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const got = await host.handleInvoke('keybindings_get', {}) as Record<string, string[]>
    expect(got).toEqual({})
    host.stop()
  })

  it('keybindings empty keys (explicitly unbound) round-trips through the host', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('keybindings_set', { action: 'undo', keys: [] })
    const got = await host.handleInvoke('keybindings_get', {}) as Record<string, string[]>
    expect('undo' in got).toBe(true)
    expect(got['undo']).toEqual([])
    host.stop()
  })

  it('recents_list returns empty list on cold start', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const got = await host.handleInvoke('recents_list', {}) as unknown[]
    expect(got).toEqual([])
    host.stop()
  })

  it('recents_set_reopen_on_launch persists and recents_get_reopen_on_launch reads it back', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    await host.handleInvoke('recents_set_reopen_on_launch', { value: true })
    const got = await host.handleInvoke('recents_get_reopen_on_launch', {})
    expect(got).toBe(true)
    host.stop()
  })

  it('recents_most_recent returns null when no entries', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    const got = await host.handleInvoke('recents_most_recent', {})
    expect(got).toBeNull()
    host.stop()
  })

  it('recents_last_new_project_parent returns null then persists after setLastNewProjectParent', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    expect(await host.handleInvoke('recents_last_new_project_parent', {})).toBeNull()
    deps.recents!.setLastNewProjectParent('/my/projects')
    expect(await host.handleInvoke('recents_last_new_project_parent', {})).toBe('/my/projects')
    host.stop()
  })

  it('recents_remove drops an entry pushed via the store push method', async () => {
    const { deps } = makeInMemoryDeps()
    const host = createTsActorHost(deps)
    host.start()
    deps.recents!.push('/proj/a', 'a')
    deps.recents!.push('/proj/b', 'b')
    await host.handleInvoke('recents_remove', { path: '/proj/a' })
    const got = await host.handleInvoke('recents_list', {}) as Array<{ name: string }>
    expect(got.length).toBe(1)
    expect(got[0]!.name).toBe('b')
    host.stop()
  })
})
