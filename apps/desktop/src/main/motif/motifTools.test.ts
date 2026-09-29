import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UserMotifStore } from './store'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { runMotifTool, type MotifToolDeps } from './motifTools'
import type { BuiltinMotif, MotifLayerRef } from './authoring'
import { unzipSync, zipSync } from 'fflate'

function m(name: string, id = 'ignored'): Manifest {
  return { id, name, version: 1, size: [100, 100], default_duration_s: 1, fonts: [], props_schema: {} }
}
function doc(man: Manifest, body = 'x'): string {
  return composeMotifHtml(man, `<head></head><body>${body}<script>motif.define({setup(){}})</script></body>`)
}

let store: UserMotifStore
let emitted: number
let refreshed: number
let rebinds: unknown[][]
let layers: MotifLayerRef[]
let logs: string[]
let deps: MotifToolDeps
const BUILTINS: BuiltinMotif[] = [{ id: 'countdown', manifest: m('Countdown', 'countdown'), html: doc(m('Countdown', 'countdown'), 'CD'), hasParamsUi: false }]

beforeEach(() => {
  store = new UserMotifStore(mkdtempSync(path.join(tmpdir(), 'motiftools-')))
  emitted = 0; refreshed = 0; rebinds = []; layers = []; logs = []
  deps = {
    store, builtins: BUILTINS,
    motifLayers: () => layers,
    dispatchRebind: (u) => { rebinds.push(u) },
    emitChanged: () => { emitted++ },
    refreshCatalog: () => { refreshed++ },
    emitLog: (e) => { logs.push(e.message) },
  }
})

describe('runMotifTool', () => {
  it('list_motifs returns the full payload with html', () => {
    const out = runMotifTool('list_motifs', {}, deps) as Record<string, unknown>[]
    expect(out.find((e) => e.id === 'countdown')!.status).toBe('builtin')
    expect(typeof out[0].html).toBe('string')
  })

  it('get_motif_source reads an id (renderer arg shape { id })', () => {
    const out = runMotifTool('get_motif_source', { id: 'countdown' }, deps) as { manifest: Manifest }
    expect(out.manifest.id).toBe('countdown')
  })

  it('write_motif_draft unwraps the renderer { args: { manifest, html } } shape, emits + refreshes', () => {
    const id = runMotifTool('write_motif_draft', { args: { manifest: m('Foo'), html: '<head></head><body>B</body>' } }, deps) as string
    expect(store.getDraft(id)).not.toBeNull()
    expect(emitted).toBe(1); expect(refreshed).toBe(1)
  })

  it('write_motif_draft also accepts the MCP flat { manifest, html, from } shape', () => {
    const id = runMotifTool('write_motif_draft', { manifest: m('Foo'), html: '<head></head><body>B</body>', from: 'countdown' }, deps) as string
    expect(store.readDraftTarget(id)).toBe('countdown')
  })

  it('MCP drafts inherit the source package resources', () => {
    store.writeDraftPackage('source', doc(m('Source', 'source')), [
      { path: 'assets/mesh.glb', bytes: Buffer.from([1, 255]) },
    ])
    store.installDraft('source', 'source')
    const id = runMotifTool('write_motif_draft', { manifest: m('Revised'), html: '<head></head><body/>', from: 'source' }, deps) as string
    expect(store.readFile(id, 'assets/mesh.glb')).toEqual(Buffer.from([1, 255]))
  })

  it('amend_motif_draft uses camelCase { draftId, source }', () => {
    store.writeDraft('d1', doc(m('D', 'd1'), 'one'))
    runMotifTool('amend_motif_draft', { draftId: 'd1', source: doc(m('D', 'hacker'), 'TWO') }, deps)
    expect(store.getDraft('d1')!.html).toContain('TWO')
    expect(emitted).toBe(1)
  })

  it('create_edit_draft uses camelCase { sourceId }', () => {
    const id = runMotifTool('create_edit_draft', { sourceId: 'countdown' }, deps) as string
    expect(store.getDraft(id)).not.toBeNull(); expect(emitted).toBe(1)
  })

  it.each([
    { path: '/some/file.html' },
    { path: '/some/folder', directory: true },
    { path: '/some/folder.zip', directory: true },
    { path: '/some/file.txt' },
    {},
  ])('rejects non-ZIP imports before reading or changing the catalog: %j', args => {
    expect(() => runMotifTool('import_motif', args, deps)).toThrow(/only .zip/)
    expect(store.listDraftIds()).toEqual([])
    expect(emitted).toBe(0); expect(refreshed).toBe(0)
  })

  it('rejects HTML renamed to .zip', () => {
    const zipPath = path.join(store.root(), 'fake.zip')
    writeFileSync(zipPath, doc(m('Not a ZIP')))
    expect(() => runMotifTool('import_motif', { path: zipPath }, deps)).toThrow()
    expect(store.listDraftIds()).toEqual([])
    expect(emitted).toBe(0); expect(refreshed).toBe(0)
  })

  it('exports, imports and installs a complete package with a fresh identity', () => {
    const bytes = Buffer.from([0, 255, 128, 3])
    store.writeDraftPackage('scene', doc(m('Scene', 'scene')), [
      { path: 'assets/model.glb', bytes }, { path: 'params.html', bytes: Buffer.from('controls') },
    ])
    store.writeDraftTarget('scene', 'original')
    const zipPath = path.join(store.root(), 'scene.ZIP')
    runMotifTool('export_motif', { id: 'scene', path: zipPath }, deps)
    expect(emitted).toBe(0)
    expect(Object.keys(unzipSync(readFileSync(zipPath)))).not.toContain('scene/target')
    const id = runMotifTool('import_motif', { path: zipPath }, deps) as string
    expect(id).not.toBe('scene')
    expect(store.readDraftTarget(id)).toBeNull()
    runMotifTool('install_motif', { draft_id: id, mode: 'new' }, deps)
    expect(store.readFile(id, 'assets/model.glb')).toEqual(bytes)
    expect(store.hasFile(id, 'params.html')).toBe(true)
    expect(store.getMotif('scene')).not.toBeNull()
    expect(emitted).toBe(2); expect(refreshed).toBe(2)
  })

  it('exports built-ins and imports a separate manifest from a ZIP', () => {
    const zipPath = path.join(store.root(), 'builtin.zip')
    runMotifTool('export_motif', { id: 'countdown', path: zipPath }, deps)
    const id = runMotifTool('import_motif', { path: zipPath }, deps) as string
    expect(store.getDraft(id)!.manifest.name).toBe('Countdown')
    writeFileSync(zipPath, zipSync({
      'scene/index.html': Buffer.from('<head></head><body>external</body>'),
      'scene/manifest.json': Buffer.from(JSON.stringify(m('External'))),
    }))
    const external = runMotifTool('import_motif', { path: zipPath }, deps) as string
    expect(store.getDraft(external)!.manifest.name).toBe('External')
  })

  it('a rejected ZIP leaves no draft and emits no catalog change', () => {
    const zipPath = path.join(store.root(), 'bad.zip')
    writeFileSync(zipPath, zipSync({ 'index.html': Buffer.from(doc(m('Bad'))), '../escape': Buffer.from('x') }))
    expect(() => runMotifTool('import_motif', { path: zipPath }, deps)).toThrow()
    expect(store.listDraftIds()).toEqual([])
    expect(emitted).toBe(0); expect(refreshed).toBe(0)
  })

  it('delete_motif removes a published motif and emits', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    runMotifTool('delete_motif', { id: 'foo' }, deps)
    expect(store.getMotif('foo')).toBeNull(); expect(emitted).toBe(1)
  })

  it('install_motif (New) publishes, returns id, no rebind dispatched', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo')))
    const id = runMotifTool('install_motif', { args: { draft_id: 'foo', mode: { kind: 'new' } } }, deps) as string
    expect(id).toBe('foo'); expect(rebinds).toEqual([]); expect(emitted).toBe(1); expect(refreshed).toBe(1)
  })

  it('install_motif (Update) dispatches the rebind built from the live layers', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    store.writeDraft('wip', doc(m('Foo', 'wip')))
    layers = [{ layerId: 'la', motifId: 'wip', version: 1, props: {} }]
    const id = runMotifTool('install_motif', { args: { draft_id: 'wip', mode: { kind: 'update', target_id: 'foo' } } }, deps) as string
    expect(id).toBe('foo')
    expect(rebinds.length).toBe(1)
    expect((rebinds[0] as any[])[0]).toMatchObject({ layer_id: 'la', motif_id: 'foo', motif_version: 2 })
  })

  it('install_motif bare "update" resolves the target the draft recorded', () => {
    const published = runMotifTool('write_motif_draft', { manifest: m('Base'), html: '<head></head><body>B</body>' }, deps) as string
    runMotifTool('install_motif', { draft_id: published, mode: 'new' }, deps)
    const draft = runMotifTool('write_motif_draft', { manifest: m('Base'), html: '<head></head><body>B2</body>', from: published }, deps) as string
    const out = runMotifTool('install_motif', { draft_id: draft, mode: 'update' }, deps) as string
    expect(out).toBe(published)
    expect(store.getMotif(published)!.manifest.version).toBe(2)
  })

  it('install_motif "update" takes an explicit target_id, and refuses when the draft records none and none is passed', () => {
    const published = runMotifTool('write_motif_draft', { manifest: m('Base'), html: '<head></head><body>B</body>' }, deps) as string
    runMotifTool('install_motif', { draft_id: published, mode: 'new' }, deps)
    const orphan = runMotifTool('write_motif_draft', { manifest: m('Loose'), html: '<head></head><body>L</body>' }, deps) as string
    expect(() => runMotifTool('install_motif', { draft_id: orphan, mode: 'update' }, deps)).toThrow(/records none.*target_id.*write_motif_draft \{ from \}.*mode "new"/)
    expect(store.getMotif(published)!.manifest.version).toBe(1)
    expect(runMotifTool('install_motif', { draft_id: orphan, mode: 'update', target_id: published }, deps)).toBe(published)
    expect(store.getMotif(published)!.manifest.version).toBe(2)
  })

  it('delete_motif refuses an unknown id and a built-in, naming list_motifs', () => {
    expect(() => runMotifTool('delete_motif', { id: 'never-written' }, deps)).toThrow(/unknown Motif 'never-written'.*list_motifs/)
    expect(() => runMotifTool('delete_motif', { id: 'countdown' }, deps)).toThrow(/built-in/)
    expect(emitted).toBe(0)
  })

  it('refuses a mode that is neither "new" nor "update" instead of reading it as an update', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo')))
    expect(() => runMotifTool('install_motif', { draft_id: 'foo', mode: 'updat' }, deps)).toThrow(/updat/)
  })

  it('install_motif accepts the MCP flat string mode "new"', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo')))
    const id = runMotifTool('install_motif', { draft_id: 'foo', mode: 'new' }, deps) as string
    expect(id).toBe('foo')
  })

  it('throws on an unhandled tool', () => {
    expect(() => runMotifTool('nope', {}, deps)).toThrow(/unhandled tool/)
  })

  it('motif_staleness_report returns [] when nothing is stale', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 2, props: {} }]
    expect(runMotifTool('motif_staleness_report', {}, deps)).toEqual([])
    expect(logs).toEqual([])
  })

  it('motif_staleness_report rows a v1 layer against a v2 published motif + logs a warn', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 1, props: { a: 1 } }]
    const report = runMotifTool('motif_staleness_report', {}, deps)
    expect(report).toEqual([{ motif_id: 'foo', name: 'Foo', placed_version: 1, current_version: 2, layer_count: 1 }])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('foo v1→v2')
  })

  it('acknowledge_motif_staleness dispatches a rebind for stale layers, returns the count, refreshes', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 1, props: { a: 1 } }]
    const count = runMotifTool('acknowledge_motif_staleness', {}, deps) as number
    expect(count).toBe(1)
    expect(rebinds.length).toBe(1)
    expect((rebinds[0] as any[])[0]).toMatchObject({ layer_id: 'la', motif_id: 'foo', motif_version: 2, props: { a: 1 } })
    expect(refreshed).toBe(1)
  })

  it('acknowledge_motif_staleness returns 0 + dispatches nothing when nothing is stale', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 2, props: {} }]
    expect(runMotifTool('acknowledge_motif_staleness', {}, deps)).toBe(0)
    expect(rebinds).toEqual([])
    expect(refreshed).toBe(1)   // refresh is unconditional (cheap, idempotent)
  })
})
