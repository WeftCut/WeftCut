// apps/desktop/src/main/state/__tests__/upgrade-scenarios.test.ts
//
// Opening a project an older release left, end to end, the way a user
// upgrading meets it: a real project folder, the Motif library in the layout
// that release left on disk (`store.upgrade()` runs first, as at launch), and
// the real open path with the production file system. Each case is a
// situation found among real projects; the steps' own rules are tested beside
// them (migrate.*.test.ts, legacyResolve.test.ts, project-folder.test.ts).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinLineage, composeMotifHtml, type Manifest } from '../../../shared/motifs/catalog'
import { isWorkspaceFailure } from '../../../shared/workspaceErrors'
import { builtinMotifs, motifRevision } from '../../motif/authoring'
import { legacyMigration } from '../../motif/legacyResolve'
import { normalize } from '../../motif/motifPackage'
import { ProjectMotifStore } from '../../motif/projectStore'
import { DRAFTS_DIR, UserMotifStore } from '../../motif/store'
import { seededGen } from '../ids'
import { upgradeWire } from '../migrate'
import type { Project } from '../model'
import { motifLayerParams } from '../mutations/motif'
import { serializeProjectToJson } from '../persistence'
import { PROJECT_FILE } from '../../../shared/projectFile'
import { openProject, type OrchestratorDeps, type OrchestratorFs, type SchemaUpgradeReport } from '../workspace-orchestrator'

const builtins = builtinMotifs('src/shared/motifs/builtin')
const MEDIA_ID = '00000000-0000-0000-0000-0000000000aa'
const GONE_LINK = '/home/u/work/motifs/scene-01'

let root: string
let libraryDir: string
let dir: string

const nodeFs: OrchestratorFs = {
  exists: p => existsSync(p),
  readFile: p => readFileSync(p, 'utf8'),
  writeFile: (p, text) => writeFileSync(p, text),
  mkdirp: d => mkdirSync(d, { recursive: true }),
  rm: p => rmSync(p, { force: true }),
  rename: (from, to) => renameSync(from, to),
}

const manifest = (name: string): Manifest => ({ id: 'x', name, version: 1, size: [320, 180], default_duration_s: 2, props_schema: {} })
const packageFiles = (id: string, name: string, version: number) => normalize([{ path: 'index.html',
  bytes: Buffer.from(composeMotifHtml(manifest(name), '<html><head></head><body><script>motif.define({frame(t){}})</script></body></html>')) }], id, version).files

/** Writes a package's files into `folder`. */
function writePackage(folder: string, files: readonly { path: string; bytes: Buffer }[]): void {
  for (const file of files) {
    mkdirSync(path.dirname(path.join(folder, file.path)), { recursive: true })
    writeFileSync(path.join(folder, file.path), file.bytes)
  }
}

/** The library as a 0.8 release left it: no format marker, an installed
 *  Motif's one version at `<id>/` (now at version 2, past the version its
 *  layer was placed at), a draft, and a draft linked to a working folder
 *  that has since gone, whose working state recorded the failure. */
function writeOldLibrary(): void {
  writePackage(path.join(libraryDir, 'lower'), packageFiles('lower', 'Lower', 2))
  writePackage(path.join(libraryDir, DRAFTS_DIR, 'sketch'), packageFiles('sketch', 'Sketch', 1))
  writePackage(path.join(libraryDir, DRAFTS_DIR, 'linked'), packageFiles('linked', 'Linked', 1))
  mkdirSync(path.join(libraryDir, '.workspaces'), { recursive: true })
  writeFileSync(path.join(libraryDir, '.workspaces', 'linked.json'), JSON.stringify({
    directory: GONE_LINK, diagnostic: `Error: ENOENT: no such file or directory, lstat '${GONE_LINK}'` }))
}

/** The frozen v5 fixture as Windows wrote it (a backslash project path into
 *  a subfolder), with a track of Motif layers on `ids`, each bound at
 *  version 1 as v5 recorded. */
function v5Wire(ids: readonly string[]): Record<string, any> {
  const wire = JSON.parse(readFileSync('fixtures/projects/v5.json', 'utf8'))
  const item = wire.media_pool[MEDIA_ID]
  item.path_rel = 'Media\\b-roll\\Clip.mp4'
  item.path_abs = 'C:\\Users\\u\\Videos\\Film\\Media\\b-roll\\Clip.mp4'
  const rootComposition = wire.compositions[wire.root_id]
  const template = rootComposition.tracks[1]
  rootComposition.tracks.push({ ...structuredClone(template), id: '00000000-0000-4000-8000-000000000200',
    layers: ids.map((id, i) => ({ ...structuredClone(template.layers[0]), id: `00000000-0000-4000-8000-00000000010${i}`,
      t_start_us: i * 1_000_000, t_end_us: (i + 1) * 1_000_000,
      params: { ...motifLayerParams(id, {}, [320, 180]), motif_version: 1 } })) })
  return wire
}

const writeProject = (wire: Record<string, unknown>) => writeFileSync(path.join(dir, PROJECT_FILE), JSON.stringify(wire, null, 2))

/** Opens `dir` through the real open path; answers the installed state and
 *  the upgrade report (null when the file was current). */
async function open(library: UserMotifStore): Promise<{ project: Project; report: SchemaUpgradeReport | null }> {
  let installed: Project | null = null
  let report: SchemaUpgradeReport | null = null
  const deps = {
    actor: { replaceState: (p: Project) => { installed = p }, snapshot: () => installed!, dispatch: vi.fn() },
    napi: { commitWorkspace: vi.fn(async () => {}), pushRecent: vi.fn(), setLastNewProjectParent: vi.fn(), enqueueJobsForMedia: vi.fn() },
    fs: nodeFs, join: path.join, idGen: seededGen(), platform: process.platform, contentFs: fsp,
    onSchemaUpgrade: (r: SchemaUpgradeReport) => { report = r },
    ...legacyMigration(library, builtins),
  } as unknown as OrchestratorDeps
  await openProject(deps, dir)
  return { project: installed!, report }
}

/** The library as the app finds it at launch: brought to this build's layout. */
function launchLibrary(): UserMotifStore {
  const library = new UserMotifStore(libraryDir)
  library.upgrade()
  return library
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'upgrade-scenarios-'))
  libraryDir = path.join(root, 'library')
  dir = path.join(root, 'Film')
  mkdirSync(path.join(dir, 'Media', 'b-roll'), { recursive: true })
  writeFileSync(path.join(dir, 'Media', 'b-roll', 'Clip.mp4'), 'c'.repeat(1024))
  writeOldLibrary()
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('a project a 0.8 release left, opened with the library it left', () => {
  const IDS = ['countdown', 'lower', 'sketch', 'linked', 'gone']

  it('copies into Motifs/ what each Motif rendered there: the built-in, the installed version, the draft', async () => {
    writeProject(v5Wire(IDS))
    const library = launchLibrary()
    const { project } = await open(library)

    expect(project.schema_version).toBeGreaterThan(5)
    // v5 rendered an installed Motif's current version whatever version the
    // layer was placed at, so the copy is that version.
    const installed = library.versions('lower')[0]!
    expect(installed.version).toBe(2)
    expect(project.motifs.lower).toEqual({ uid: library.lineage.of('lower'), revision: installed.revision,
      from: { uid: library.lineage.of('lower'), version: 2, revision: installed.revision } })
    expect(project.motifs.countdown!.from).toEqual({ uid: builtinLineage('countdown'), version: 1, revision: motifRevision(library, builtins, 'countdown') })
    expect(project.motifs.sketch).toMatchObject({ uid: library.lineage.of(`${DRAFTS_DIR}/sketch`), from: null })
    const copies = new ProjectMotifStore(dir)
    for (const id of ['countdown', 'lower', 'sketch']) expect(copies.status(id).revision, id).toBe(project.motifs[id]!.revision)
    // Every layer still names a Motif of the table.
    const layerIds = Object.values(project.compositions).flatMap(c => c.tracks.flatMap(t => t.layers))
      .flatMap(l => l.params.kind === 'Motif' ? [l.params.motif_id] : [])
    expect(new Set(layerIds)).toEqual(new Set(IDS))
    expect(Object.keys(project.motifs).sort()).toEqual([...IDS].sort())
  })

  it('leaves a draft whose linked folder was gone missing, as it rendered nothing, and names that draft and why', async () => {
    writeProject(v5Wire(IDS))
    const { project, report } = await open(launchLibrary())

    expect(project.motifs.linked!.revision).toBeNull()
    expect(project.motifs.gone!.revision).toBeNull()
    const draft = path.join(libraryDir, DRAFTS_DIR, 'linked')
    expect(report!.missingMotifs).toEqual(expect.arrayContaining([
      { id: 'linked', draft, diagnostic: expect.stringContaining(GONE_LINK) },
      { id: 'gone' },
    ]))
    expect(report!.missingMotifs).toHaveLength(2)

    // The named draft, copied to Motifs/<id>/, is a package under that key:
    // the route the report points at.
    cpSync(draft, path.join(dir, 'Motifs', 'linked'), { recursive: true })
    expect(new ProjectMotifStore(dir).status('linked').status).toBe('ok')
  })

  it("keeps the library's drafts and the original project file", async () => {
    const wire = v5Wire(IDS)
    writeProject(wire)
    const original = readFileSync(path.join(dir, PROJECT_FILE), 'utf8')
    const { report } = await open(launchLibrary())

    expect(readFileSync(path.join(dir, report!.backupFile), 'utf8')).toBe(original)
    for (const id of ['sketch', 'linked']) expect(existsSync(path.join(libraryDir, DRAFTS_DIR, id, 'index.html')), id).toBe(true)
  })

  it('finds media Windows recorded with backslashes in a subfolder, and stores no absolute path', async () => {
    writeProject(v5Wire(IDS))
    const { project } = await open(launchLibrary())

    const item = project.media_pool[MEDIA_ID]!
    expect(item.path_rel).toBe('Media/b-roll/Clip.mp4')
    expect(item.path_abs).toBe(path.join(dir, 'Media', 'b-roll', 'Clip.mp4'))
    expect(serializeProjectToJson(project)).not.toContain('C:\\\\Users')
  })

  it('reopened after its first save, upgrades nothing and writes nothing more', async () => {
    writeProject(v5Wire(IDS))
    const library = launchLibrary()
    const first = await open(library)
    writeFileSync(path.join(dir, PROJECT_FILE), serializeProjectToJson(first.project))
    const before = readdirSync(dir).sort()
    const motifsBefore = readdirSync(path.join(dir, 'Motifs')).sort()

    const second = await open(library)
    expect(second.report).toBeNull()
    expect(second.project.motifs).toEqual(first.project.motifs)
    expect(readdirSync(dir).sort()).toEqual(before)
    expect(readdirSync(path.join(dir, 'Motifs')).sort()).toEqual(motifsBefore)
  })
})

describe('a project an earlier upgrade left without its Motifs', () => {
  it('names the draft beside each missing Motif and copies none by itself', async () => {
    // v6 as an upgrade without the library wrote it: every entry missing.
    const { wire } = upgradeWire(v5Wire(['sketch', 'gone']), 5, 6)
    writeProject(wire)
    const { project, report } = await open(launchLibrary())

    expect(report!.missingMotifs).toEqual(expect.arrayContaining([
      { id: 'sketch', draft: path.join(libraryDir, DRAFTS_DIR, 'sketch') },
      { id: 'gone' },
    ]))
    // A v6 table is the project's own: an id is never filled from this
    // machine's drafts, which may hold another Motif of that name.
    expect(project.motifs.sketch!.revision).toBeNull()
    expect(existsSync(path.join(dir, 'Motifs', 'sketch'))).toBe(false)
  })
})

describe('a file older than the first release', () => {
  it('is refused with its reason, and nothing is written', async () => {
    // Pre-release builds stamped v1 on transforms with a bare x/y.
    const wire = JSON.parse(readFileSync('fixtures/projects/v1.json', 'utf8'))
    for (const composition of Object.values(wire.compositions) as any[]) {
      for (const track of composition.tracks) for (const layer of track.layers) {
        const t = layer.params.transform
        if (!t?.position) continue
        t.x = t.position.x; t.y = t.position.y
        delete t.position
      }
    }
    writeProject(wire)
    const original = readFileSync(path.join(dir, PROJECT_FILE), 'utf8')
    const before = readdirSync(dir).sort()

    const failure = await open(launchLibrary()).then(() => null, (e: unknown) => e)
    expect(isWorkspaceFailure(failure)).toBe(true)
    expect(JSON.stringify((failure as { err: unknown }).err)).toMatch(/older than the first release/)
    expect(readFileSync(path.join(dir, PROJECT_FILE), 'utf8')).toBe(original)
    expect(readdirSync(dir).sort()).toEqual(before)
  })
})
