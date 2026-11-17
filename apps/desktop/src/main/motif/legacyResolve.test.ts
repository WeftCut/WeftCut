// The v5 → v6 upgrade end to end: a v5 project opened through the real open
// path, with a real library and project folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { builtinLineage, composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { blankProject, type Layer, type Project } from '../state/model'
import { seededGen } from '../state/ids'
import { motifLayerParams } from '../state/mutations/motif'
import { serializeProject } from '../state/serialize'
import { openProject, type OrchestratorDeps, type OrchestratorFs, type SchemaUpgradeReport } from '../state/workspace-orchestrator'
import { builtinMotifs, motifRevision } from './authoring'
import { legacyDraftIds, legacyDraftsNotice, legacyMigration, resolveLegacyMotif } from './legacyResolve'
import { packageContentHash } from './contentHash'
import { MotifResolver } from './resolver'
import { normalize } from './motifPackage'
import { readMotifDirectory } from './packageFiles'
import { ProjectMotifStore } from './projectStore'
import { DRAFTS_DIR, UserMotifStore } from './store'

let root: string
let library: UserMotifStore
let projectDir: string
const builtins = builtinMotifs('src/shared/motifs/builtin')

const manifest = (name: string, size: [number, number] = [320, 180]): Manifest => ({ id: 'x', name, version: 1, size, default_duration_s: 2, props_schema: {} })
const page = (name: string, size?: [number, number]) =>
  Buffer.from(composeMotifHtml(manifest(name, size), '<html><head></head><body><script>motif.define({frame(t){}})</script></body></html>'))

/** A v5 project.json whose overlay track holds a layer on each of `ids`. */
function v5Project(ids: string[]): string {
  const project = blankProject(seededGen(), 'Film')
  const root = project.compositions[project.root_id]
  const layers: Layer[] = ids.map((id, i) => ({
    id: `00000000-0000-4000-8000-00000000010${i}`, label: null, t_start_us: i * 1_000_000, t_end_us: (i + 1) * 1_000_000,
    enabled: true, locked: false, metadata: {}, params: motifLayerParams(id, {}, [320, 180]), effects: [],
  }))
  root.tracks.push({ id: '00000000-0000-4000-8000-000000000200', label: null, enabled: true, locked: false, muted: false, solo: false,
    removable: true, role: null, transient: false, height_px: 64, layers })
  const wire = serializeProject(project) as Record<string, unknown>
  delete wire.motifs
  return JSON.stringify({ ...wire, schema_version: 5 }, null, 2)
}

const nodeFs: OrchestratorFs = {
  exists: p => existsSync(p),
  readFile: p => readFileSync(p, 'utf8'),
  writeFile: (p, text) => writeFileSync(p, text),
  mkdirp: d => mkdirSync(d, { recursive: true }),
  rm: p => rmSync(p, { force: true }),
}

/** Opens the project; answers the state installed and the upgrade report. */
async function open(): Promise<{ project: Project; report: SchemaUpgradeReport }> {
  let installed: Project | null = null
  let report: SchemaUpgradeReport | null = null
  const deps = {
    actor: { replaceState: (p: Project) => { installed = p }, snapshot: () => installed! },
    napi: { commitWorkspace: vi.fn(async () => {}), pushRecent: vi.fn(), setLastNewProjectParent: vi.fn(), enqueueJobsForMedia: vi.fn() },
    fs: nodeFs, join: path.join, idGen: seededGen(),
    onSchemaUpgrade: (r: SchemaUpgradeReport) => { report = r },
    ...legacyMigration(library, builtins),
  } as unknown as OrchestratorDeps
  await openProject(deps, projectDir)
  return { project: installed!, report: report! }
}

const motifsDir = () => path.join(projectDir, 'Motifs')
const draftDir = (id: string) => path.join(library.root(), DRAFTS_DIR, id)
/** Writes a draft as an older release left it in the library folder. */
function writeDraft(id: string, files: readonly { path: string; bytes: Buffer }[]): void {
  for (const file of files) {
    mkdirSync(path.dirname(path.join(draftDir(id), file.path)), { recursive: true })
    writeFileSync(path.join(draftDir(id), file.path), file.bytes)
  }
}
const draftFiles = (id: string) => readMotifDirectory(draftDir(id))

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'legacy-motifs-'))
  library = new UserMotifStore(path.join(root, 'library'))
  library.addVersion('lower', 1, normalize([{ path: 'index.html', bytes: page('Lower') }, { path: 'art.svg', bytes: Buffer.from('<svg/>') }], 'lower', 1).files)
  const draft = normalize([{ path: 'index.html', bytes: page('Sketch') }], 'sketch-draft', 1)
  writeDraft('sketch-draft', draft.files)
  projectDir = path.join(root, 'Film')
  mkdirSync(projectDir)
  writeFileSync(path.join(projectDir, 'project.json'), v5Project(['countdown', 'lower', 'sketch-draft', 'gone']))
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('opening a v5 project', () => {
  it('copies what each Motif rendered into Motifs/, keeping its revision and lineage', async () => {
    const { project, report } = await open()
    const libraryRevision = library.installedListing('lower')!.revision
    expect(project.motifs).toEqual({
      countdown: { uid: builtinLineage('countdown'), revision: motifRevision(library, builtins, 'countdown'),
        from: { uid: builtinLineage('countdown'), version: 1, revision: motifRevision(library, builtins, 'countdown') } },
      lower: { uid: library.lineage.of('lower'), revision: libraryRevision, from: { uid: library.lineage.of('lower'), version: 1, revision: libraryRevision } },
      'sketch-draft': { uid: library.lineage.of(`${DRAFTS_DIR}/sketch-draft`), revision: packageContentHash(draftFiles('sketch-draft')), from: null },
      gone: { uid: expect.any(String), revision: null, from: null },
    })
    // Each copy's folder hashes to its source's revision, so its stored frames keep their keys.
    const copies = new ProjectMotifStore(projectDir)
    for (const id of ['countdown', 'lower', 'sketch-draft']) expect(copies.status(id).revision).toBe(project.motifs[id]!.revision)
    expect(copies.status('gone').status).toBe('missing')
    expect(report.missingMotifs).toEqual([{ id: 'gone' }])
  })

  it('opened again, keeps the folders it made and adopts one edited since', async () => {
    const first = await open()
    writeFileSync(path.join(motifsDir(), 'lower', 'notes.txt'), 'added by hand')
    const edited = new ProjectMotifStore(projectDir).status('lower').revision
    const second = await open()
    expect(second.project.motifs.lower!.revision).toBe(edited)
    expect(second.project.motifs.lower!.from).toEqual(first.project.motifs.lower!.from)
    expect(readFileSync(path.join(motifsDir(), 'lower', 'notes.txt'), 'utf8')).toBe('added by hand')
    for (const id of ['countdown', 'sketch-draft']) expect(second.project.motifs[id]).toEqual(first.project.motifs[id])
  })

  it('opens when a copy fails, leaving that Motif missing and its folder untouched', async () => {
    mkdirSync(path.join(motifsDir(), 'lower'), { recursive: true })
    writeFileSync(path.join(motifsDir(), 'lower', 'readme.txt'), 'not a Motif')
    const { project, report } = await open()
    expect(project.motifs.lower).toMatchObject({ uid: library.lineage.of('lower'), revision: null })
    expect(report.missingMotifs).toEqual(expect.arrayContaining([{ id: 'lower', diagnostic: expect.stringMatching(/index\.html/) }]))
    expect(readMotifDirectory(path.join(motifsDir(), 'lower')).map(f => f.path)).toEqual(['readme.txt'])
    expect(project.motifs.countdown!.revision).not.toBeNull()
  })

  it("hears each copy where the open project's revisions are heard, as placed", async () => {
    const resolver = new MotifResolver(library, builtins)
    const heard: Array<[string, string]> = []
    resolver.onRevisionSeen((id, _revision, cause) => heard.push([id, cause]))
    const placeMigratedMotifs = legacyMigration(library, builtins, project => resolver.hear(project)).placeMigratedMotifs
    const copy = (id: string) => ({ id, revision: resolveLegacyMotif(library, builtins, id)!.revision })
    const outcomes = placeMigratedMotifs(projectDir, [copy('lower'), copy('sketch-draft')])
    expect(outcomes.every(o => o.revision !== null)).toBe(true)
    expect(heard).toEqual([['lower', 'placed'], ['sketch-draft', 'placed']])
  })

  it("sizes a Motif for the v3 → v4 step from the project folder first", () => {
    const own = normalize([{ path: 'index.html', bytes: page('Lower', [640, 360]) }], 'lower', 7).files
    new ProjectMotifStore(projectDir).materialize('lower', own, 'placed')
    const { migration } = legacyMigration(library, builtins)
    expect(migration(projectDir).motifSize!('lower', 7)).toEqual([640, 360])
    expect(migration(projectDir).motifSize!('lower', 1)).toEqual([320, 180])
  })
})

describe("an older release's drafts", () => {
  it('resolve as v5 rendered them: a draft, a linked mirror, and not a linked directory that was invalid', () => {
    const linked = normalize([{ path: 'index.html', bytes: page('Linked') }], 'linked-draft', 1)
    writeDraft('linked-draft', linked.files)
    writeDraft('broken-link', normalize([{ path: 'index.html', bytes: page('Broken') }], 'broken-link', 1).files)
    mkdirSync(path.join(library.root(), '.workspaces'), { recursive: true })
    writeFileSync(path.join(library.root(), '.workspaces', 'linked-draft.json'), JSON.stringify({ directory: '/home/u/work/linked' }))
    writeFileSync(path.join(library.root(), '.workspaces', 'broken-link.json'), JSON.stringify({ directory: '/home/u/work/broken', diagnostic: 'index.html is missing' }))
    expect(resolveLegacyMotif(library, builtins, 'sketch-draft')).toMatchObject({ revision: packageContentHash(draftFiles('sketch-draft')), from: null })
    expect(resolveLegacyMotif(library, builtins, 'linked-draft')).toMatchObject({ revision: packageContentHash(linked.files), from: null })
    expect(resolveLegacyMotif(library, builtins, 'broken-link')).toBeNull()
  })

  it('make one notice naming how many and where, and nothing lists or moves them', () => {
    writeDraft('second-draft', normalize([{ path: 'index.html', bytes: page('Second') }], 'second-draft', 1).files)
    mkdirSync(draftDir('empty-folder'))
    const before = draftFiles('sketch-draft')
    expect(legacyDraftIds(library)).toEqual(['second-draft', 'sketch-draft'])
    expect(legacyDraftsNotice(library)).toEqual({ level: 'info', code: 'motif_drafts_left', args: { count: 2, folder: path.join(library.root(), DRAFTS_DIR) } })
    expect(library.listManifests().map(m => m.id)).toEqual(['lower'])
    expect(draftFiles('sketch-draft')).toEqual(before)
    expect(legacyDraftsNotice(new UserMotifStore(path.join(root, 'empty-library')))).toBeNull()
  })
})
