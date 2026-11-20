// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layer, LayerParams, Project } from '../state/model'
import { FontCatalog } from './catalog'
import { ProjectFontStore, USE_DEBOUNCE_MS, type FontLogEntry, type ProjectFontsFs } from './projectFonts'
import { readFaces } from './sfnt'
import { cmapFormat12, cmapTable, faceTables, font, ttc } from './testing/syntheticFonts'
import type { MotifFontManifest } from './uses'

let root: string
let systemDir: string
let projectDir: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-project-fonts-'))
  systemDir = path.join(root, 'system')
  projectDir = path.join(root, 'project')
  fs.mkdirSync(systemDir, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(root, { recursive: true, force: true })
})

/** A face drawing a–z. */
const latin = () => cmapTable([{ platform: 3, encoding: 10, data: cmapFormat12([{ start: 0x61, end: 0x7a, glyph: 1 }]) }])

function installFont(name: string, spec: Parameters<typeof font>[0]): void {
  fs.writeFileSync(path.join(systemDir, name), font({ cmap: latin(), ...spec }))
}

const fontsDir = () => path.join(projectDir, 'Fonts')
const inFonts = () => (fs.existsSync(fontsDir()) ? fs.readdirSync(fontsDir()).sort() : [])

function textLayer(content: string, family: string, weight = 400): Layer {
  const params = { kind: 'Text', content, font: { family, size_px: 40, weight, italic: false } } as unknown as LayerParams
  return { id: `text-${family}-${weight}`, label: null, t_start_us: 0, t_end_us: 1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

function projectOf(layers: Layer[], excluded: string[] = []): Pick<Project, 'compositions' | 'settings'> {
  return {
    compositions: { root: { id: 'root', tracks: [{ id: 't', layers }] } } as unknown as Project['compositions'],
    settings: { excluded_fonts: excluded } as Project['settings'],
  }
}

function motifLayer(id: string, props: Record<string, unknown>): Layer {
  const params = { kind: 'Motif', motif_id: 'card', props } as unknown as LayerParams
  return { id, label: null, t_start_us: 0, t_end_us: 1, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

/** The store over a real catalog and folder, its file calls, trash and
 *  exclusion writes recorded in one list. */
async function harness(layers: Layer[], excluded: string[] = [], manifest: MotifFontManifest = () => null) {
  const catalog = new FontCatalog({ systemDirs: [systemDir] })
  await catalog.scanSystem()
  const calls: string[] = []
  const logs: FontLogEntry[] = []
  const name = (p: string) => path.basename(p)
  let hold: Promise<void> | null = null
  const recorded: ProjectFontsFs = {
    mkdir: (d, o) => fs.promises.mkdir(d, o),
    readdir: (d) => fs.promises.readdir(d),
    readFile: ((p: string, e?: 'utf8') => (e ? fs.promises.readFile(p, e) : fs.promises.readFile(p))) as ProjectFontsFs['readFile'],
    stat: (p) => fs.promises.stat(p),
    rm: async (p, o) => { calls.push(`rm ${name(p)}`); await fs.promises.rm(p, o) },
    writeFile: async (p, data) => {
      if (path.dirname(p) === fontsDir()) calls.push(`write ${name(p)}`)
      if (hold) await hold
      await fs.promises.writeFile(p, data)
      if (path.dirname(p) === fontsDir()) calls.push(`wrote ${name(p)}`)
    },
    rename: async (a, b) => { calls.push(`rename ${name(a)} -> ${name(b)}`); await fs.promises.rename(a, b) },
  }
  let project = projectOf(layers, excluded)
  const store: ProjectFontStore = new ProjectFontStore({
    catalog, fs: recorded, join: path.join, basename: path.basename,
    trash: async (file) => { calls.push(`trash ${name(file)}`); await fs.promises.rm(file) },
    recordExcluded: (list) => {
      calls.push(`record ${list.join(',')}`)
      project = { ...project, settings: { ...project.settings, excluded_fonts: list } }
      store.published(project, manifest)
    },
    emitLog: (entry) => { logs.push(entry) },
    changed: () => {}, indexChanged: () => {}, progress: () => {},
    uuid: () => 'u1',
  })
  // As the host does: the opened project is published, then its folder told.
  const open = async () => { store.published(project, manifest); store.projectChanged(projectDir); await store.settled() }
  const edit = (next: Layer[]) => { project = { ...project, compositions: projectOf(next).compositions }; store.published(project, manifest) }
  return { store, catalog, calls, logs, open, edit, holdWrites: (p: Promise<void> | null) => { hold = p } }
}

describe('copying into Fonts/', () => {
  it('writes the face as .part and renames it; the final name appears only by the rename', async () => {
    installFont('Example-Regular.ttf', { family: 'Example' })
    const h = await harness([textLayer('abc', 'Example')])
    await h.open()
    expect(h.calls.filter(c => c.startsWith('write') || c.startsWith('rename'))).toEqual([
      'write .Example-Regular.ttf.u1.part',
      'rename .Example-Regular.ttf.u1.part -> Example-Regular.ttf',
    ])
    expect(inFonts()).toEqual(['Example-Regular.ttf'])
  })

  it('extracts a collection face to a standalone file', async () => {
    fs.writeFileSync(path.join(systemDir, 'Pair.ttc'), ttc([
      faceTables({ family: 'Pair', weight: 400, cmap: latin() }),
      faceTables({ family: 'Pair', weight: 700, cmap: latin() }),
    ]))
    const h = await harness([textLayer('a', 'Pair', 700)])
    await h.open()
    expect(inFonts()).toEqual(['Pair-700.ttf'])
    const faces = readFaces(fs.readFileSync(path.join(fontsDir(), 'Pair-700.ttf')))
    expect(faces.map(f => f.ttcIndex)).toEqual([null])
  })

  it('deletes a .part an earlier session left when the folder opens', async () => {
    fs.mkdirSync(fontsDir())
    fs.writeFileSync(path.join(fontsDir(), '.Old.ttf.0f1e.part'), 'half')
    const h = await harness([])
    await h.open()
    expect(inFonts()).toEqual([])
  })

  it('logs one line for a batch, naming every family it first copied, and none when nothing is copied', async () => {
    installFont('Example-Regular.ttf', { family: 'Example' })
    installFont('Second-Regular.ttf', { family: 'Second' })
    const h = await harness([textLayer('a', 'Example'), textLayer('b', 'Second')])
    await h.open()
    expect(h.logs.map(l => l.i18n_key)).toEqual(['log.fonts_copied'])
    expect([...(h.logs[0]!.i18n_args.names as string[])].sort()).toEqual(['Example', 'Second'])
    h.store.projectChanged(null)
    await h.open()
    expect(h.logs).toHaveLength(1)
  })

  it('copies a collected face that went missing from Fonts/ again, and says so', async () => {
    installFont('Example-Regular.ttf', { family: 'Example' })
    const h = await harness([textLayer('a', 'Example')])
    await h.open()
    h.store.projectChanged(null)
    fs.rmSync(path.join(fontsDir(), 'Example-Regular.ttf'))
    await h.open()
    expect(inFonts()).toEqual(['Example-Regular.ttf'])
    expect(h.logs.map(l => [l.i18n_key, l.i18n_args])).toEqual([
      ['log.fonts_copied', { names: ['Example'], more: 0 }],
      ['log.font_recopied', { name: 'Example' }],
    ])
  })

  it('copies the face a Motif\'s text prop draws with again when it went missing, with no capture', async () => {
    installFont('Display-Regular.ttf', { family: 'Display' })
    const manifest: MotifFontManifest = () => ({
      props_schema: { font_headline: { type: 'string', default: "'Display', sans-serif" }, headline: { type: 'string', default: 'abc' } },
    })
    const h = await harness([motifLayer('M1', {})], [], manifest)
    await h.open()
    expect(inFonts()).toEqual(['Display-Regular.ttf'])
    h.store.projectChanged(null)
    fs.rmSync(path.join(fontsDir(), 'Display-Regular.ttf'))
    await h.open()
    expect(inFonts()).toEqual(['Display-Regular.ttf'])
    expect(h.logs.map(l => l.i18n_key)).toEqual(['log.fonts_copied', 'log.font_recopied'])
  })

  it('logs a missing family once while the folder is open, naming how many layers ask for it', async () => {
    const h = await harness([textLayer('a', 'Gone')])
    await h.open()
    h.store.systemScanned()
    await h.store.settled()
    expect(h.logs.map(l => [l.i18n_key, l.i18n_args])).toEqual([['log.fonts_missing', { name: 'Gone', layers: 1 }]])
    expect(h.store.missing()).toEqual([{ family: 'Gone', weight: 400, italic: false, layer_ids: ['text-Gone-400'] }])
  })
})

describe('closing', () => {
  it('drain waits for the copy in flight and refuses new batches until the folder is told again', async () => {
    installFont('Example-Regular.ttf', { family: 'Example' })
    const h = await harness([textLayer('a', 'Example')])
    let land!: () => void
    h.holdWrites(new Promise<void>(r => { land = r }))
    const opening = h.open()
    await vi.waitFor(() => expect(h.calls).toContain('write .Example-Regular.ttf.u1.part'))
    const draining = h.store.drain().then(() => { h.calls.push('drained') })
    land()
    await Promise.all([opening, draining])
    expect(h.calls.indexOf('drained')).toBeGreaterThan(h.calls.indexOf('rename .Example-Regular.ttf.u1.part -> Example-Regular.ttf'))
    expect(inFonts()).toEqual(['Example-Regular.ttf'])
    fs.rmSync(path.join(fontsDir(), 'Example-Regular.ttf'))
    h.edit([textLayer('ab', 'Example')])
    await h.store.settled()
    expect(inFonts()).toEqual([])
  })
})

describe('the exclusion list', () => {
  it('never queues an excluded family, on open or when what the project draws changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    installFont('Example-Regular.ttf', { family: 'Example' })
    installFont('Example-Bold.ttf', { family: 'Example', weight: 700 })
    const h = await harness([textLayer('a', 'Example')], ['example'])
    await h.open()
    h.edit([textLayer('a', 'Example'), textLayer('b', 'Example', 700)])
    vi.advanceTimersByTime(USE_DEBOUNCE_MS)
    await h.store.settled()
    expect(h.calls.filter(c => c.startsWith('write'))).toEqual([])
    expect(inFonts()).toEqual([])
  })

  it('records the exclusion before it moves the family\'s files to the trash', async () => {
    installFont('Example-Regular.ttf', { family: 'Example' })
    const h = await harness([textLayer('a', 'Example')])
    await h.open()
    const view = await h.store.exclude('Example')
    const order = h.calls.filter(c => c.startsWith('record') || c.startsWith('trash'))
    expect(order).toEqual(['record Example', 'trash Example-Regular.ttf'])
    expect(inFonts()).toEqual([])
    expect(view?.excluded).toEqual([{ family: 'Example', installed: true }])
    expect(view?.copied).toEqual([])
  })

  it('excluding a family whose copy is in flight leaves no file of it in Fonts/ and logs no copy of it', async () => {
    installFont('Example-Regular.ttf', { family: 'Example' })
    installFont('Example-Bold.ttf', { family: 'Example', weight: 700 })
    const h = await harness([textLayer('a', 'Example'), textLayer('b', 'Example', 700)])
    let land!: () => void
    h.holdWrites(new Promise<void>(r => { land = r }))
    const opening = h.open()
    await vi.waitFor(() => expect(h.calls.some(c => c.startsWith('write'))).toBe(true))
    const excluding = h.store.exclude('Example')
    land()
    h.holdWrites(null)
    await Promise.all([opening, excluding])
    await h.store.settled()
    expect(inFonts()).toEqual([])
    expect(h.calls.filter(c => c.startsWith('write'))).toHaveLength(1)
    expect(h.logs).toEqual([])
  })

  it('Allow copying copies the family at once and logs nothing', async () => {
    installFont('Example-Regular.ttf', { family: 'Example' })
    const h = await harness([textLayer('a', 'Example')], ['Example'])
    await h.open()
    expect(inFonts()).toEqual([])
    const view = await h.store.allow('Example')
    expect(inFonts()).toEqual(['Example-Regular.ttf'])
    expect(view?.copied).toEqual([{ family: 'Example', files: 1, bytes: expect.any(Number) }])
    expect(view?.excluded).toEqual([])
    expect(h.logs).toEqual([])
  })

  it('Allow copying while the open indexes Fonts/ logs nothing', async () => {
    installFont('Example-Regular.ttf', { family: 'Example' })
    const h = await harness([textLayer('a', 'Example')], ['Example'])
    let land!: () => void
    const indexing = new Promise<void>(r => { land = r })
    const rescan = h.catalog.rescanProject.bind(h.catalog)
    let held = false
    h.catalog.rescanProject = async () => { held = true; await indexing; return rescan() }
    const opening = h.open()
    await vi.waitFor(() => expect(held).toBe(true))
    const allowing = h.store.allow('Example')
    land()
    await Promise.all([opening, allowing])
    expect(inFonts()).toEqual(['Example-Regular.ttf'])
    expect(h.logs).toEqual([])
  })
})
