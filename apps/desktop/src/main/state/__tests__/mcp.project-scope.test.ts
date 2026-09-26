// apps/desktop/src/main/state/__tests__/mcp.project-scope.test.ts
// With no project open — the start screen, or after the user closed theirs —
// every MCP tool outside the pinned app-scope list refuses with
// `NoProjectOpen` and commits nothing. The sweep runs over the WHOLE advertised
// catalog, so a new tool is refused by default and making one app-scoped means
// editing the pinned list below in the same diff.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { MCP_TOOL_DEFS, type ToolAnnotations } from '../mcp-commands'
import { MOTIF_TOOL_DEFS } from '../../mcp/motifToolDefs'
import { mergeMcpCatalog, mergeMcpResources } from '../../mcp/mcpCatalog'
import { HOST_RESOURCE_DEFS } from '../../mcp/hostResources'
import { APP_SCOPE_RESOURCES, APP_SCOPE_TOOLS, MOTIF_TOOLS } from '../../mcp/mutationTools'
import { handleCallTool, handleReadResource, sessionView } from '../../mcp/server'
import { NO_PROJECT_OPEN_MESSAGE } from '../../mcp/toolResult'
import { createTsActorHost } from '../ts-actor-host'
import { PROJECT_OPENED_EVENT } from '../../../shared/project-events'

vi.mock('../../motif/capture.js', () => ({ captureMotifFrameB64: async () => 'iVBOR' }))

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const rust = JSON.parse(RUST_CATALOG) as {
  tools: Array<{ name: string; description: string; input_schema?: unknown; inputSchema?: unknown; annotations?: Record<string, unknown> }>
  resources: Array<{ uri: string; name: string }>
}
const merged = mergeMcpCatalog(
  rust.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: (t.inputSchema ?? t.input_schema) as Record<string, unknown>, annotations: t.annotations as ToolAnnotations | undefined })),
  [...MCP_TOOL_DEFS, ...MOTIF_TOOL_DEFS],
)
const resources = mergeMcpResources(rust.resources as never, HOST_RESOURCE_DEFS as never) as Array<{ uri: string }>
const backend = { mcpCallTool: async () => { throw new Error('a refused call must not reach the backend') }, mcpReadResource: async () => { throw new Error('a refused read must not reach the backend') }, mcpCatalog: async () => RUST_CATALOG } as any

const PINNED_APP_SCOPE = [
  'ping',
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'preview_motif_draft', 'install_motif', 'delete_motif',
  'open_project', 'create_project',
]

/** A production-shaped host over an in-memory filesystem: nothing is open. */
function host(recents: { parent?: string | null } = {}) {
  const vfs: Record<string, string> = {}
  const dirs = new Set<string>()
  const sent: Array<[string, unknown]> = []
  const fs = {
    exists: (p: string) => p in vfs || dirs.has(p),
    readFile: (p: string) => { if (!(p in vfs)) throw new Error(`vfs: ${p}`); return vfs[p]! },
    writeFile: (p: string, t: string) => { vfs[p] = t },
    mkdirp: (d: string) => { dirs.add(d) },
    copyFile: (s: string, d: string) => { vfs[d] = vfs[s]! },
    readdir: (d: string) => Object.keys(vfs).filter((k) => k.startsWith(d + '/')).map((k) => k.slice(d.length + 1)),
    rm: (p: string) => { delete vfs[p] },
  }
  const recentsStore = {
    list: () => [{ path: '/work/Old', name: 'Old', last_opened: '2026-01-01T00:00:00.000Z' }],
    lastNewProjectParent: () => (recents.parent === undefined ? null : recents.parent),
  }
  const ts = createTsActorHost({
    send: (event: string, payload: unknown) => { sent.push([event, payload]) },
    mcpNotify: () => {},
    fileExists: (p: string) => fs.exists(p),
    fs,
    join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
    napi: { commitWorkspace: async () => {}, pushRecent: () => {}, setLastNewProjectParent: () => {}, enqueueJobsForMedia: async () => {} },
    compute: { probeMedia: async () => '{}', hashMediaSource: async () => 'h', parseSubtitles: async () => '{}', synthesizeSpeechCompute: async () => '{}' },
    enqueueWorkspaceCopy: async () => {},
    readFile: (p: string) => fs.readFile(p),
    statPath: () => ({ kind: 'file' as const, readable: true }),
    workspaceDir: () => null,
    recents: recentsStore,
  } as any)
  ts.start()
  return { ts, sent, fs }
}
const call = (ts: unknown, name: string, args: Record<string, unknown> = {}) => handleCallTool(backend, () => ts as any, name, args) as Promise<any>

describe('no project open: the app-scope list', () => {
  it('is pinned, and names only real tools', () => {
    expect([...APP_SCOPE_TOOLS].sort()).toEqual([...PINNED_APP_SCOPE].sort())
    const advertised = new Set(merged.map((t) => t.name))
    for (const n of APP_SCOPE_TOOLS) expect(advertised.has(n) || MOTIF_TOOLS.has(n), n).toBe(true)
  })
})

describe('no project open: every other tool refuses and commits nothing', () => {
  it('refuses the whole advertised catalog outside the app-scope list', async () => {
    const { ts } = host()
    const before = ts.actor.snapshot()
    const len = ts.actor.historyStatus().len
    const checkpoints = ts.actor.listCheckpoints().length
    const gated = [
      ...merged.map((t) => t.name).filter((n) => !APP_SCOPE_TOOLS.has(n)),
      'motif_staleness_report', 'acknowledge_motif_staleness',
    ]
    expect(gated.length).toBeGreaterThan(50)
    for (const name of gated) {
      const out = await call(ts, name, { reason: 'x', label: 'x', layer_id: 'x' })
      expect(out.isError, name).toBe(true)
      expect(out.structuredContent?.error, name).toBe('NoProjectOpen')
      expect(out.content[0].text, name).toBe(NO_PROJECT_OPEN_MESSAGE)
    }
    expect(ts.actor.snapshot()).toBe(before)
    expect(ts.actor.historyStatus().len).toBe(len)
    expect(ts.actor.listCheckpoints()).toHaveLength(checkpoints)
  })

  it('refuses every read_project view but session and effects', async () => {
    const { ts } = host()
    for (const view of ['current', 'composition', 'compositions', 'media', 'tracks', 'markers', 'links', 'transitions', 'settings', 'history']) {
      const out = await call(ts, 'read_project', { view })
      expect(out.structuredContent?.error, view).toBe('NoProjectOpen')
    }
    expect((await call(ts, 'read_project', { view: 'session' })).isError).toBeFalsy()
    expect((await call(ts, 'read_project', { view: 'effects' })).isError).toBeFalsy()
  })

  it('keeps an unknown tool the JSON-RPC unknown-tool error', async () => {
    const { ts } = host()
    await expect(call(ts, 'no_such_tool')).rejects.toThrow()
  })

  it('refuses every project resource but the app-scope ones', async () => {
    const { ts } = host()
    const projectUris = resources.map((r) => r.uri).filter((u) => u.startsWith('project://') && !APP_SCOPE_RESOURCES.has(u))
    expect(projectUris.length).toBeGreaterThan(3)
    for (const uri of projectUris) {
      await expect(handleReadResource(backend, () => ts, uri), uri).rejects.toThrow(NO_PROJECT_OPEN_MESSAGE)
    }
    await expect(handleReadResource(backend, () => ts, 'project://session')).resolves.toBeTruthy()
  })
})

describe('the session view reports the open project', () => {
  it('null on the start screen, the folder after New, null again after Close', async () => {
    const { ts } = host({ parent: '/work' })
    expect(sessionView(ts)).toMatchObject({ project: null, recent_projects: [{ name: 'Old', path: '/work/Old' }], default_parent_folder: '/work' })
    await ts.handleInvoke('project_new_workspace', { parentFolder: '/work', name: 'Cut', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    expect(sessionView(ts)).toMatchObject({ project: { name: 'Cut', dir: '/work/Cut' } })
    expect((await call(ts, 'add_track', { label: 'ok' })).isError).toBeFalsy()
    await ts.handleInvoke('project_close', {})
    expect(sessionView(ts)).toMatchObject({ project: null })
    expect((await call(ts, 'add_track', { label: 'after close' })).structuredContent?.error).toBe('NoProjectOpen')
  })
})

describe('open_project / create_project', () => {
  it('create_project makes and opens a project, and the editor is told to follow', async () => {
    const { ts, sent } = host({ parent: '/work' })
    const out = await call(ts, 'create_project', { name: 'Demo', width: 3840, height: 2160, fps: { num: 30000, den: 1001 } })
    expect(out.isError).toBeFalsy()
    expect(out.structuredContent).toEqual({ name: 'Demo', dir: '/work/Demo', replaced: null })
    expect(ts.openedProject()).toEqual({ dir: '/work/Demo' })
    const root = ts.actor.snapshot().compositions[ts.actor.snapshot().root_id]!
    expect([root.width, root.height, root.fps]).toEqual([3840, 2160, { num: 30000, den: 1001 }])
    expect(sent).toContainEqual([PROJECT_OPENED_EVENT, { dir: '/work/Demo' }])
  })

  it('open_project opens a project folder and names the one it replaced', async () => {
    const { ts } = host({ parent: '/work' })
    await call(ts, 'create_project', { name: 'A' })
    await call(ts, 'create_project', { name: 'B' })
    const out = await call(ts, 'open_project', { path: '/work/A' })
    expect(out.structuredContent).toEqual({ name: 'A', dir: '/work/A', replaced: '/work/B' })
    expect(ts.openedProject()).toEqual({ dir: '/work/A' })
  })

  it('refuses a missing folder, a non-project folder and an existing target, by name, changing nothing', async () => {
    const { ts, fs } = host({ parent: '/work' })
    const missing = await call(ts, 'open_project', { path: '/nowhere/X' })
    expect(missing.structuredContent?.error).toBe('ProjectFolderMissing')
    expect(missing.content[0].text).toContain('/nowhere/X does not exist')
    fs.mkdirp('/work/Plain')
    const plain = await call(ts, 'open_project', { path: '/work/Plain' })
    expect(plain.structuredContent?.error).toBe('NotProjectFolder')
    await call(ts, 'create_project', { name: 'Taken' })
    const taken = await call(ts, 'create_project', { name: 'Taken' })
    expect(taken.structuredContent?.error).toBe('ProjectFolderExists')
    expect(taken.content[0].text).toContain('/work/Taken already exists')
    expect(ts.openedProject()).toEqual({ dir: '/work/Taken' })
  })

  it('create_project with no parent_folder and no default asks for one', async () => {
    const { ts } = host()
    const out = await call(ts, 'create_project', { name: 'Demo' })
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('needs parent_folder')
    expect(ts.openedProject()).toBeNull()
  })

  it("applies the New Project dialog's name and canvas rules", async () => {
    const { ts } = host({ parent: '/work' })
    expect((await call(ts, 'create_project', { name: 'a:b' })).content[0].text).toContain("can't contain")
    expect((await call(ts, 'create_project', { name: 'CON' })).content[0].text).toContain('reserves')
    expect((await call(ts, 'create_project', { name: 'x', width: 1921, height: 1080 })).content[0].text).toContain('even')
    expect((await call(ts, 'create_project', { name: 'x', width: 1920 })).content[0].text).toContain('together')
    expect((await call(ts, 'create_project', { name: 'x', fps: { num: 48, den: 1 } })).content[0].text).toContain('not a WeftCut rate')
    expect((await call(ts, 'open_project', { path: 'relative/dir' })).content[0].text).toContain('absolute path')
    expect(ts.openedProject()).toBeNull()
  })
})
