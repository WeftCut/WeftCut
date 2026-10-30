import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { invokeCmd, launchApp, newProject, tmpDir, waitForHook } from './helpers/driver'
import { supportsMotifSharedTextures } from './helpers/motif-gpu'
import { createMotifDraft, publishMotifDraft } from './helpers/motif'
import { hashCacheKey } from '../../src/shared/motifs/cacheKey'
import type { MotifBakeSnapshot } from '../../src/shared/motifs/baking'
import { VECTORS_PATH, compareReadback, downscaleReference, encodePng, syntheticFrame } from '../lib/motif-downscale.mjs'

// ADR 0154 completion criterion 1: one conformance suite for every Motif read
// lane. The same five cases run on each lane the platform has:
//
// - macOS and Linux: `utility`, the reader utility process and worker.
// - Windows: `texture`, the shared-texture lane (skipped where Chromium cannot
//   import D3D shared images), and `fallback`, the utility lane reached because
//   `motif:read` is replaced to answer `unavailable` for every read.
//
// Seams. The texture lane is forced `unavailable`, injected with a failure or
// held by replacing its IPC handler or the native pool method from the spec.
// The utility process is found by its service name in `app.getAppMetrics()`
// and killed from main. The one product seam is the utility's E2E-only read
// hold (src/main/motif/readerE2EHold.ts): with
// WEFTCUT_E2E_MOTIF_READER_HOLD_FRAME=N, reads of frame N stay inside the
// utility, admitted under their workspace generation, until a read of frame
// N + 1 arrives. Only reads of those frame numbers are affected; the Motif
// layer every case adds has 30 frames, so the preview never asks for them.
//
// Every test frame is written under the layer's own hash, which is live: the
// raster collection that runs with each bake plan would delete any other
// directory.

const addon = fileURLToPath(new URL('../../native/index.js', import.meta.url))
const READER_SERVICE = 'WeftCut Motif reader'

type Lane = 'utility' | 'texture' | 'fallback'
type Div = 1 | 2 | 4
const DIVS: readonly Div[] = [1, 2, 4]
const LANES: readonly Lane[] = process.platform === 'win32' ? ['texture', 'fallback'] : ['utility']
// How a canvas read-back is compared with the reference (e2e/lib/motif-downscale.mjs):
// the utility lane is straight RGBA up to the worker's bitmap, so alpha and
// opaque texels are exact and translucent colour is within 2 premultiplied;
// its straight bytes are compared exactly at the native core. The texture lane
// premultiplies before upload: every channel within 2 premultiplied.
const RULE = { utility: 'straight', fallback: 'straight', texture: 'premultiplied' } as const

/** Frames the preview never reads (the layer has 30). */
const FIRST_REFERENCE = 1000
const HOLD = 5000
const RELEASE = HOLD + 1
const SENTINEL = HOLD + 2
/** `.wfrm` header bytes; damage stays behind them so the header still parses. */
const FRAME_HEADER_BYTES = 52

interface Reference { name: string; width: number; height: number; rgba: Uint8Array }
interface Vector { name: string; width: number; height: number; div: Div; rgba: number[]; expected: { width: number; height: number; rgba: number[] } }

const VECTORS = (JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as { cases: Vector[] }).cases
/** Each distinct vector input once, then an odd size with every kind of alpha. */
const REFERENCES: Reference[] = (() => {
  const seen = new Map<string, Reference>()
  for (const c of VECTORS) {
    const key = `${c.width}x${c.height}:${c.rgba.join(',')}`
    if (!seen.has(key)) seen.set(key, { name: c.name.replace(/ \/\d$/, ''), width: c.width, height: c.height, rgba: Uint8Array.from(c.rgba) })
  }
  return [...seen.values(), { name: 'synthetic varying alpha', width: 1001, height: 563, rgba: syntheticFrame(1001, 563) }]
})()
/** Small, translucent and odd: the frame the lifecycle cases read. */
const PROBE = REFERENCES.find(r => r.name.startsWith('7x5'))!

const MOTIF = { id: 'reader-conformance', name: 'Reader conformance', version: 1, size: [64, 64], default_duration_s: 1, props_schema: {} }
const MOTIF_HTML = `<!doctype html><html><body style="margin:0"><script>
  motif.define({ frame(t) { document.body.style.background = 'rgb(60,' + Math.floor(t * 200) + ',140)'; }});
</script></body></html>`

interface ReaderStats {
  reads: { texture: number; utility: number };
  misses: number;
  fallbacks: number;
  transportFailures: number;
  restarts: number;
}

type Outcome =
  | { kind: 'bitmap'; width: number; height: number; rgba?: string }
  | { kind: 'null' }
  | { kind: 'error'; name: string; lane: string | null; reason: string | null; message: string }

type Background =
  | { state: 'pending' }
  | { state: 'bitmap' }
  | { state: 'null' }
  | { state: 'rejected'; name: string; lane: string | null; reason: string | null; message: string }

interface Workspace { projectPath: string; cacheKey: string; hash: string; dir: string; motifId: string; frames: number }

const describeOutcome = (outcome: Outcome | Background | null) => JSON.stringify(outcome, (key, value) => key === 'rgba' ? '…' : value)

/** Polls until `read` gives a value, then returns it. */
async function eventually<T>(read: () => Promise<T | null | undefined>, message: string, timeout = 15_000): Promise<T> {
  let value: T | null | undefined = null
  await expect.poll(async () => (value = await read()) != null, { timeout, message }).toBe(true)
  return value as T
}

const launch = () => launchApp({ env: {
  ELECTRON_RENDERER_URL: '',
  WEFTCUT_MOTIF_CAPTURE: 'png',
  WEFTCUT_E2E_MOTIF_READER_HOLD_FRAME: String(HOLD),
} })

async function requireLane(app: ElectronApplication, lane: Lane): Promise<void> {
  if (lane === 'texture') {
    test.skip(!await supportsMotifSharedTextures(app), 'The texture lane needs Chromium D3D shared images; the forced fallback still runs')
  }
}

/** The Windows fallback: the texture lane answers `unavailable` to every read. */
async function forceUtilityFallback(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as { __readerConformanceTexture?: { asked: number } }
    if (g.__readerConformanceTexture) return
    const state = { asked: 0 }
    g.__readerConformanceTexture = state
    ipcMain.removeHandler('motif:read')
    ipcMain.handle('motif:read', async () => { state.asked++; return { kind: 'unavailable' } })
  })
}

const textureAsked = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { __readerConformanceTexture?: { asked: number } }).__readerConformanceTexture?.asked ?? 0)

/** The reader utility's pid, or null while none runs. */
const readerPid = (app: ElectronApplication) => app.evaluate(({ app }, name) =>
  app.getAppMetrics().find(metric => metric.type === 'Utility' && metric.name === name && metric.pid > 0)?.pid ?? null, READER_SERVICE)

const killReader = (app: ElectronApplication, pid: number) => app.evaluate((_electron, pid) => { process.kill(pid, 'SIGKILL') }, pid)

/** Counts `motif:reader-connect` in main: one per port a document asks for. */
async function countConnects(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as { __readerConformanceConnects?: { count: number } }
    if (g.__readerConformanceConnects) return
    const state = { count: 0 }
    g.__readerConformanceConnects = state
    ipcMain.on('motif:reader-connect', () => { state.count++ })
  })
}
const connectCount = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as { __readerConformanceConnects?: { count: number } }).__readerConformanceConnects?.count ?? 0)

/** `.wfrm` bytes for each PNG, from the native encoder main uses. */
async function encodeFrames(app: ElectronApplication, pngs: Buffer[]): Promise<Buffer[]> {
  const encoded = await app.evaluate(async (_electron, { addon, pngs }) => {
    const native = process.getBuiltinModule('module').createRequire(addon)(addon)
    const out: string[] = []
    for (const png of pngs) out.push((await native.motifEncodePng(Buffer.from(png, 'base64'), true)).toString('base64'))
    return out
  }, { addon, pngs: pngs.map(png => png.toString('base64')) })
  return encoded.map(value => Buffer.from(value, 'base64'))
}

/** Flips one payload byte: the header parses, the read fails verification. */
function corrupt(bytes: Buffer): Buffer {
  expect(bytes.length, 'frame too small to corrupt behind its header').toBeGreaterThan(FRAME_HEADER_BYTES + 4)
  const out = Buffer.from(bytes)
  const at = Math.max(FRAME_HEADER_BYTES, Math.floor(out.length * 3 / 4))
  out[at] = out[at]! ^ 0xff
  return out
}

/** Keeps the header and part of the payload. */
function truncate(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes.subarray(0, Math.max(FRAME_HEADER_BYTES + 1, Math.floor(bytes.length / 2))))
  expect(out.length, 'frame too small to truncate behind its header').toBeLessThan(bytes.length)
  return out
}

const bakeSnapshot = (page: Page) => invokeCmd<MotifBakeSnapshot>(page, 'motif_bake_snapshot')

async function reopen(page: Page, projectPath: string): Promise<void> {
  await waitForHook(page, 'motifReopenProject')
  const result = await page.evaluate(p => (window as any).__weftcutTest.motifReopenProject({ path: p })
    .then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error: String(error) })), projectPath) as { ok: boolean; error?: string }
  if (!result.ok) throw new Error(`motifReopenProject failed: ${result.error}`)
}

/**
 * A 64×64 project with one 1 s Motif layer, baked (so the preview's own reads
 * hit valid frames and never miss), with `files` written under the layer's
 * hash and listed in coverage.
 */
async function openWorkspace(
  app: ElectronApplication, page: Page, lane: Lane, name: string,
  options: { motifId?: string; files?: Record<number, Buffer> } = {},
): Promise<Workspace> {
  await newProject(page, { parentFolder: tmpDir('weftcut-motif-reader-'), name, canvas: { width: 64, height: 64, fpsNum: 30, fpsDen: 1 } })
  // Before the layer exists, so the preview's first read already falls back.
  if (lane === 'fallback') await forceUtilityFallback(app)
  await invokeCmd(page, 'app_settings_set', { patch: { prebake_motifs: true } })
  const motifId = options.motifId ?? await publishMotifDraft(page, await createMotifDraft(page, MOTIF, MOTIF_HTML))
  await waitForHook(page, 'addMotifLayer')
  const layerId = await page.evaluate(id => (window as any).__weftcutTest.addMotifLayer({ motifId: id, durationUs: 1_000_000 }), motifId) as string
  const cacheKey = await eventually(() => page.evaluate(id => (window as any).__weftcutTest.cacheKeyForLayer(id) as Promise<string | null>, layerId),
    `${name}: the Motif layer has no cache key`)
  const projectPath = await invokeCmd<string>(page, 'workspace_dir')
  const hash = hashCacheKey(cacheKey)
  const dir = path.join(projectPath, 'Cache', 'raster', hash)
  let frames = 0
  const baked = (files: readonly number[]) => expect.poll(async () => {
    const snapshot = await bakeSnapshot(page)
    const status = snapshot.statuses[cacheKey]
    const covered = new Set(snapshot.coverage[cacheKey] ?? [])
    frames = status?.total ?? 0
    return status?.phase === 'ready' && status.total > 0 && status.done === status.total && files.every(frame => covered.has(frame))
  }, { timeout: 90_000, message: `${name}: the layer did not finish baking, or coverage lacks frames ${files.join(', ')}` }).toBe(true)
  // Discovery for the plan naming this hash is done, and with it the
  // collection of older plans: files written from now on are kept. Every
  // layer frame exists, so no later preview read misses.
  await baked([])
  const files = Object.entries(options.files ?? {}).map(([frame, bytes]) => ({ frame: Number(frame), bytes }))
  if (files.length) {
    await fs.mkdir(dir, { recursive: true })
    for (const { frame, bytes } of files) await fs.writeFile(path.join(dir, `${frame}.wfrm`), bytes)
    // Discovery is stat-only and runs when a workspace opens.
    await reopen(page, projectPath)
    await baked(files.map(f => f.frame))
  }
  return { projectPath, cacheKey, hash, dir, motifId, frames }
}

/** One read through the document's reader; the bitmap is read back from a
 * 2D canvas as straight RGBA (base64). */
async function readFrame(page: Page, hash: string, frame: number, div: Div, pixels = true): Promise<Outcome> {
  return page.evaluate(async ({ hash, frame, div, pixels }) => {
    try {
      const bitmap = await (window as any).__weftcutTest.readMotifFrame({ hash, frame, div }) as ImageBitmap | null
      if (!bitmap) return { kind: 'null' as const }
      const { width, height } = bitmap
      if (!pixels) { bitmap.close(); return { kind: 'bitmap' as const, width, height } }
      const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      const data = ctx.getImageData(0, 0, width, height).data
      let binary = ''
      for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000))
      return { kind: 'bitmap' as const, width, height, rgba: btoa(binary) }
    } catch (error) {
      const e = error as { name?: unknown; lane?: unknown; reason?: unknown; message?: unknown } | null
      return {
        kind: 'error' as const, name: String(e?.name ?? ''), lane: typeof e?.lane === 'string' ? e.lane : null,
        reason: typeof e?.reason === 'string' ? e.reason : null, message: String(e?.message ?? error),
      }
    }
  }, { hash, frame, div, pixels }) as Promise<Outcome>
}

/** Starts a read the spec does not await; `readState` reports how it ended. */
async function startRead(page: Page, key: string, hash: string, frame: number, div: Div): Promise<void> {
  await page.evaluate(({ key, hash, frame, div }) => {
    const w = window as any
    const reads = (w.__readerConformance ??= {}) as Record<string, unknown>
    reads[key] = { state: 'pending' }
    ;(w.__weftcutTest.readMotifFrame({ hash, frame, div }) as Promise<ImageBitmap | null>).then(bitmap => {
      reads[key] = { state: bitmap ? 'bitmap' : 'null' }
      bitmap?.close()
    }, (error: { name?: unknown; lane?: unknown; reason?: unknown; message?: unknown } | null) => {
      reads[key] = {
        state: 'rejected', name: String(error?.name ?? ''), lane: typeof error?.lane === 'string' ? error.lane : null,
        reason: typeof error?.reason === 'string' ? error.reason : null, message: String(error?.message ?? error),
      }
    })
  }, { key, hash, frame, div })
}
const readState = (page: Page, key: string) =>
  page.evaluate(key => ((window as any).__readerConformance?.[key] ?? null), key) as Promise<Background | null>
const settled = (page: Page, key: string, timeout = 30_000) => eventually(async () => {
  const state = await readState(page, key)
  return state && state.state !== 'pending' ? state : null
}, `the read "${key}" never settled`, timeout)

async function readerStats(page: Page): Promise<ReaderStats> {
  await waitForHook(page, 'motifReaderStats')
  return page.evaluate(() => (window as any).__weftcutTest.motifReaderStats()) as Promise<ReaderStats>
}

/** `ours` reads went through `lane`. The preview reads its layer on the same
 * lane, so lane counters only bound ours from below. */
function expectLane(lane: Lane, before: ReaderStats, after: ReaderStats, ours: number): void {
  const delta = (pick: (stats: ReaderStats) => number) => pick(after) - pick(before)
  if (lane === 'texture') {
    expect(delta(s => s.reads.texture), 'reads answered by the texture lane').toBeGreaterThanOrEqual(ours)
    expect(delta(s => s.reads.utility), 'the texture lane must not fall back to the utility lane').toBe(0)
    expect(delta(s => s.fallbacks), 'texture-lane fallbacks').toBe(0)
  } else {
    expect(delta(s => s.reads.utility), 'reads answered by the utility lane').toBeGreaterThanOrEqual(ours)
    expect(delta(s => s.reads.texture), 'reads answered by the texture lane').toBe(0)
    if (lane === 'fallback') expect(delta(s => s.fallbacks), 'every read falls back from the texture lane').toBeGreaterThanOrEqual(ours)
    else expect(delta(s => s.fallbacks), 'no texture lane off Windows').toBe(0)
  }
}

function expectPixels(outcome: Outcome, expected: { width: number; height: number; rgba: Uint8Array }, rule: 'straight' | 'premultiplied', label: string): void {
  expect(outcome.kind, `${label}: expected a bitmap, got ${describeOutcome(outcome)}`).toBe('bitmap')
  if (outcome.kind !== 'bitmap' || !outcome.rgba) throw new Error(`${label}: no pixels read back`)
  expect([outcome.width, outcome.height], `${label}: bitmap size`).toEqual([expected.width, expected.height])
  const result = compareReadback({
    expected: expected.rgba, actual: new Uint8Array(Buffer.from(outcome.rgba, 'base64')),
    width: expected.width, height: expected.height, rule,
  })
  expect(result.mismatches, `${label}: ${result.mismatches} texels break the ${rule} rule (max premultiplied error ${result.maxError}); first: ${JSON.stringify(result.first)}`).toBe(0)
}

const reference = (ref: Reference, div: Div) => downscaleReference(ref.rgba, ref.width, ref.height, div)
const HOLD_HINT = 'is the build an E2E build (WEFTCUT_E2E_BUILD folds the utility read hold in)?'

for (const lane of LANES) {
  test(`@serial Motif reader (${lane} lane) reads reference frames at div 1, 2 and 4 exactly`, async () => {
    test.setTimeout(240_000)
    // The reference is the native filter (node:test checks this too).
    for (const c of VECTORS) {
      const out = downscaleReference(Uint8Array.from(c.rgba), c.width, c.height, c.div)
      expect({ width: out.width, height: out.height, rgba: [...out.rgba] }, `reference vs vector "${c.name}"`).toEqual(c.expected)
    }
    const { app, page } = await launch()
    try {
      await requireLane(app, lane)
      const ws = await openWorkspace(app, page, lane, 'Reader pixels')
      const encoded = await encodeFrames(app, REFERENCES.map(ref => encodePng(ref.rgba, ref.width, ref.height)))
      await fs.mkdir(ws.dir, { recursive: true })
      for (const [i, bytes] of encoded.entries()) await fs.writeFile(path.join(ws.dir, `${FIRST_REFERENCE + i}.wfrm`), bytes)

      const before = await readerStats(page)
      const askedBefore = await textureAsked(app)
      let reads = 0
      for (const [i, ref] of REFERENCES.entries()) {
        const frame = FIRST_REFERENCE + i
        for (const div of DIVS) {
          const expected = reference(ref, div)
          const label = `${ref.name} ${ref.width}x${ref.height} at div ${div} (${lane} lane)`
          // The native core every lane runs: straight, and exact.
          const core = await app.evaluate(async (_electron, { addon, file, div }) => {
            const native = process.getBuiltinModule('module').createRequire(addon)(addon)
            const { width, height, rgba } = await native.motifReadFrameScaled(file, div)
            return { width, height, rgba: Buffer.from(rgba).toString('base64') }
          }, { addon, file: path.join(ws.dir, `${frame}.wfrm`), div })
          expect([core.width, core.height], `${label}: core output size`).toEqual([expected.width, expected.height])
          expect(Buffer.from(core.rgba, 'base64').equals(Buffer.from(expected.rgba)), `${label}: core straight bytes differ from the reference`).toBe(true)
          expectPixels(await readFrame(page, ws.hash, frame, div), expected, RULE[lane], label)
          reads++
        }
      }
      const after = await readerStats(page)
      expectLane(lane, before, after, reads)
      if (lane === 'fallback') expect((await textureAsked(app)) - askedBefore, 'the texture lane was asked first').toBeGreaterThanOrEqual(reads)
      expect(after.transportFailures - before.transportFailures, 'transport failures').toBe(0)
    } finally { await app.close() }
  })

  test(`@serial Motif reader (${lane} lane) reports corrupt and truncated frames to main as misses`, async () => {
    test.setTimeout(240_000)
    const { app, page } = await launch()
    try {
      await requireLane(app, lane)
      const ws = await openWorkspace(app, page, lane, 'Reader misses')
      const damaged = { corrupt: ws.frames - 10, truncated: ws.frames - 9 }
      expect(damaged.corrupt, 'the layer has too few frames').toBeGreaterThan(0)
      const covered = (await bakeSnapshot(page)).coverage[ws.cacheKey] ?? []
      for (const frame of Object.values(damaged)) {
        expect(covered, `frame ${frame} is baked`).toContain(frame)
        expect((await readFrame(page, ws.hash, frame, 1, false)).kind, `frame ${frame} reads before it is damaged`).toBe('bitmap')
      }
      // Hold every encode: the replacement capture the miss admits cannot
      // land, so the dropped coverage stays observable.
      await app.evaluate((_electron, addon) => {
        const native = process.getBuiltinModule('module').createRequire(addon)(addon)
        const original = native.motifEncodePng
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const state = { calls: 0, release: () => { native.motifEncodePng = original; release() } }
        ;(globalThis as any).__readerConformanceEncodes = state
        native.motifEncodePng = async (...args: unknown[]) => { state.calls++; await gate; return original(...args) }
      }, addon)
      const files = {
        corrupt: path.join(ws.dir, `${damaged.corrupt}.wfrm`),
        truncated: path.join(ws.dir, `${damaged.truncated}.wfrm`),
      }
      const written = {
        corrupt: corrupt(await fs.readFile(files.corrupt)),
        truncated: truncate(await fs.readFile(files.truncated)),
      }
      await fs.writeFile(files.corrupt, written.corrupt)
      await fs.writeFile(files.truncated, written.truncated)

      const before = await readerStats(page)
      for (const [kind, frame] of Object.entries(damaged)) {
        for (const div of [1, 2] as const) {
          const outcome = await readFrame(page, ws.hash, frame, div, false)
          expect(outcome, `${kind} frame ${frame} at div ${div} must be a miss (null), got ${describeOutcome(outcome)}`).toEqual({ kind: 'null' })
        }
      }
      // Main dropped both from coverage...
      await expect.poll(async () => {
        const now = new Set((await bakeSnapshot(page)).coverage[ws.cacheKey] ?? [])
        return { corrupt: now.has(damaged.corrupt), truncated: now.has(damaged.truncated) }
      }, { timeout: 15_000, message: 'misses must be reported to main and drop the frames from coverage' }).toEqual({ corrupt: false, truncated: false })
      // ...and admitted a replacement capture, which reached the encoder.
      await expect.poll(() => app.evaluate(() => (globalThis as any).__readerConformanceEncodes.calls as number),
        { timeout: 30_000, message: 'no replacement capture was admitted' }).toBeGreaterThanOrEqual(1)
      const after = await readerStats(page)
      expect(after.misses - before.misses, 'reader misses').toBeGreaterThanOrEqual(4)
      expect(after.transportFailures - before.transportFailures, 'a bad file is not a transport failure').toBe(0)
      expectLane(lane, before, after, 4)

      await app.evaluate(() => (globalThis as any).__readerConformanceEncodes.release())
      await expect.poll(async () => {
        const now = new Set((await bakeSnapshot(page)).coverage[ws.cacheKey] ?? [])
        return now.has(damaged.corrupt) && now.has(damaged.truncated)
      }, { timeout: 60_000, message: 'the replacement captures did not restore coverage' }).toBe(true)
      for (const [kind, frame] of Object.entries(damaged)) {
        const outcome = await readFrame(page, ws.hash, frame, 1, false)
        expect(outcome, `${kind} frame ${frame} reads again after its re-capture`).toMatchObject({ kind: 'bitmap', width: 64, height: 64 })
      }
      expect((await fs.readFile(files.corrupt)).equals(written.corrupt), 'the corrupt file was replaced').toBe(false)
      expect((await fs.readFile(files.truncated)).equals(written.truncated), 'the truncated file was replaced').toBe(false)
    } finally {
      await app.evaluate(() => (globalThis as any).__readerConformanceEncodes?.release()).catch(() => {})
      await app.close()
    }
  })

  test(`@serial Motif reader (${lane} lane) keeps a transport failure distinct from a miss`, async () => {
    test.setTimeout(240_000)
    const { app, page } = await launch()
    try {
      await requireLane(app, lane)
      const [probe] = await encodeFrames(app, [encodePng(PROBE.rgba, PROBE.width, PROBE.height)])
      const ws = await openWorkspace(app, page, lane, 'Reader transport', { files: { [FIRST_REFERENCE]: probe!, [HOLD]: probe! } })
      const expected = reference(PROBE, 1)
      const readProbe = async (label: string) => expectPixels(await readFrame(page, ws.hash, FIRST_REFERENCE, 1), expected, RULE[lane], label)
      await readProbe('probe before the failure')
      const coverageBefore = (await bakeSnapshot(page)).coverage[ws.cacheKey]
      const before = await readerStats(page)

      if (lane === 'texture') {
        // The texture lane's transport fails (as a lost slot or a closed
        // consumer would): the read is retried once, then rejected.
        await app.evaluate(({ ipcMain }, hold) => {
          const handlers = (ipcMain as any)._invokeHandlers as Map<string, (event: unknown, args: any) => unknown>
          const original = handlers.get('motif:read')
          if (!original) throw new Error('motif:read has no handler')
          const state = { injected: 0, restore: () => { handlers.set('motif:read', original) } }
          ;(globalThis as any).__readerConformanceInjection = state
          handlers.set('motif:read', async (event: unknown, args: { frame?: unknown }) => {
            if (args?.frame === hold) { state.injected++; throw new Error('injected texture transport failure') }
            return original(event, args)
          })
        }, HOLD)
        const outcome = await readFrame(page, ws.hash, HOLD, 1, false)
        expect(outcome, `a transport failure must reject, never return null: ${describeOutcome(outcome)}`)
          .toMatchObject({ kind: 'error', name: 'MotifTransportError', lane: 'texture' })
        expect(await app.evaluate(() => (globalThis as any).__readerConformanceInjection.injected as number), 'one attempt and one retry').toBe(2)
        await app.evaluate(() => (globalThis as any).__readerConformanceInjection.restore())
        expectPixels(await readFrame(page, ws.hash, HOLD, 1), expected, RULE[lane], 'the frame reads once the lane recovers')
      } else {
        const first = await eventually(() => readerPid(app), `no "${READER_SERVICE}" utility process in app.getAppMetrics()`)
        await startRead(page, 'held', ws.hash, HOLD, 1)
        // One port, in order: once this later read is answered, the held read
        // is inside the utility.
        await readProbe('probe behind the held read')
        expect(await readState(page, 'held'), `the held read was answered: ${HOLD_HINT}`).toEqual({ state: 'pending' })

        await killReader(app, first)
        await expect.poll(async () => (await readerStats(page)).transportFailures - before.transportFailures,
          { timeout: 15_000, message: 'killing the utility mid-read did not fail the read in flight' }).toBeGreaterThanOrEqual(1)
        expect(await readState(page, 'held'), 'the first transport failure is retried, not returned').toEqual({ state: 'pending' })
        // The retry reconnects to the restarted utility and is held there; the
        // probe behind it on the new port proves it arrived.
        await readProbe('probe after the restart')
        const second = await eventually(async () => {
          const pid = await readerPid(app)
          return pid !== null && pid !== first ? pid : null
        }, 'the utility process did not restart')
        expect(await readState(page, 'held'), 'the retry is in flight in the restarted utility').toEqual({ state: 'pending' })

        await killReader(app, second)
        const held = await settled(page, 'held')
        expect(held, `a transport failure must reject, never return null: ${describeOutcome(held)}`)
          .toMatchObject({ state: 'rejected', name: 'MotifTransportError', lane: 'utility' })
        // The next read succeeds after the restart.
        await readProbe('first read after the second restart')
        const third = await readerPid(app)
        expect(third, 'a third utility process serves the next read').not.toBeNull()
        expect([first, second], 'the utility restarted').not.toContain(third)
        expect((await readerStats(page)).restarts - before.restarts, 'utility lane restarts').toBeGreaterThanOrEqual(2)
      }
      const after = await readerStats(page)
      expect(after.misses - before.misses, 'a transport failure is never counted as a miss').toBe(0)
      expect(after.transportFailures - before.transportFailures, 'both attempts failed on the transport').toBeGreaterThanOrEqual(2)
      expect((await bakeSnapshot(page)).coverage[ws.cacheKey], 'coverage is unchanged').toEqual(coverageBefore)
      expect((await fs.readFile(path.join(ws.dir, `${HOLD}.wfrm`))).equals(probe!), 'the frame file was not rewritten').toBe(true)
    } finally {
      await app.evaluate(() => (globalThis as any).__readerConformanceInjection?.restore()).catch(() => {})
      await app.close()
    }
  })

  test(`@serial Motif reader (${lane} lane) ignores a miss reported after a workspace switch`, async () => {
    test.setTimeout(300_000)
    const { app, page } = await launch()
    try {
      await requireLane(app, lane)
      const [valid] = await encodeFrames(app, [encodePng(PROBE.rgba, PROBE.width, PROBE.height)])
      // The same Motif layer in both projects names the same frame addresses.
      // The new workspace holds a valid HOLD frame and a corrupt SENTINEL; the
      // old one a corrupt HOLD frame.
      const next = await openWorkspace(app, page, lane, 'Reader generation new', { files: { [HOLD]: valid!, [SENTINEL]: corrupt(valid!) } })
      const old = await openWorkspace(app, page, lane, 'Reader generation old', { motifId: next.motifId, files: { [HOLD]: corrupt(valid!) } })
      expect(old.hash, 'both projects must address the same Motif content').toBe(next.hash)
      const oldGeneration = (await bakeSnapshot(page)).generation

      if (lane === 'texture') {
        // Hold the native upload: main has bound the old workspace's store
        // and file when it reaches the pool.
        await app.evaluate((_electron, { addon, hold }) => {
          const native = process.getBuiltinModule('module').createRequire(addon)(addon)
          const proto = native.MotifGpuPool?.prototype
          if (typeof proto?.uploadFile !== 'function') throw new Error('MotifGpuPool.uploadFile is missing')
          const original = proto.uploadFile
          let release!: () => void
          const gate = new Promise<void>(resolve => { release = resolve })
          const state = { held: 0, release: () => { proto.uploadFile = original; release() } }
          ;(globalThis as any).__readerConformanceUploads = state
          const file = new RegExp(`[\\\\/]${hold}\\.wfrm$`)
          proto.uploadFile = async function (this: unknown, path: string, ...rest: unknown[]) {
            if (file.test(path)) { state.held++; await gate }
            return original.call(this, path, ...rest)
          }
        }, { addon, hold: HOLD })
      }
      const before = await readerStats(page)
      await startRead(page, 'stale', old.hash, HOLD, 1)
      if (lane === 'texture') {
        await expect.poll(() => app.evaluate(() => (globalThis as any).__readerConformanceUploads.held as number),
          { timeout: 15_000, message: 'the texture read never reached the pool' }).toBeGreaterThanOrEqual(1)
      } else {
        // One port, in order: once this answers, the held read was admitted
        // under the old generation.
        expect((await readFrame(page, old.hash, 0, 1, false)).kind, 'a baked frame behind the held read').toBe('bitmap')
      }
      expect(await readState(page, 'stale'), `the held read was answered before the switch: ${HOLD_HINT}`).toEqual({ state: 'pending' })

      await reopen(page, next.projectPath)
      const newGeneration = await eventually(async () => {
        const snapshot = await bakeSnapshot(page)
        const covered = new Set(snapshot.coverage[next.cacheKey] ?? [])
        return snapshot.generation !== oldGeneration && covered.has(HOLD) && covered.has(SENTINEL) ? snapshot.generation : null
      }, 'the new workspace did not discover its frames', 30_000)

      if (lane === 'texture') await app.evaluate(() => (globalThis as any).__readerConformanceUploads.release())
      else expect((await readFrame(page, next.hash, RELEASE, 1, false)).kind, 'the release frame is absent: a miss').toBe('null')
      const stale = await settled(page, 'stale')
      // A read that outlives the reader's 15 s timeout is retried under the
      // new generation; then this case tests nothing.
      expect((await readerStats(page)).transportFailures - before.transportFailures,
        'the held read failed on the transport (did the workspace switch take longer than the 15 s read timeout?)').toBe(0)
      // It read the file it was admitted with: the old workspace's corrupt
      // frame, so a miss for the old generation.
      expect(stale, `the held read must miss on the old workspace's file: ${describeOutcome(stale)}`).toEqual({ state: 'null' })

      // A miss in the new generation, reported after the stale one: once it
      // drops from coverage, main has handled both reports.
      expect((await readFrame(page, next.hash, SENTINEL, 1, false)).kind, 'the corrupt sentinel is a miss').toBe('null')
      await expect.poll(async () => (await bakeSnapshot(page)).coverage[next.cacheKey]?.includes(SENTINEL),
        { timeout: 15_000, message: 'the new generation\'s own miss must drop its frame' }).toBe(false)
      const after = await bakeSnapshot(page)
      expect(after.generation, 'still the new workspace').toBe(newGeneration)
      expect(after.coverage[next.cacheKey], 'a miss reported for the old generation must not drop the new store\'s frame').toContain(HOLD)
    } finally {
      await app.evaluate(() => (globalThis as any).__readerConformanceUploads?.release()).catch(() => {})
      await app.close()
    }
  })

  test(`@serial Motif reader (${lane} lane) retires a reloaded document's port and keeps reading`, async () => {
    test.setTimeout(240_000)
    const { app, page } = await launch()
    try {
      await requireLane(app, lane)
      await countConnects(app)
      const [probe] = await encodeFrames(app, [encodePng(PROBE.rgba, PROBE.width, PROBE.height)])
      const ws = await openWorkspace(app, page, lane, 'Reader lifetime', { files: { [FIRST_REFERENCE]: probe!, [HOLD]: probe! } })
      const file = path.join(ws.dir, `${FIRST_REFERENCE}.wfrm`)
      const readAll = async (label: string) => {
        for (const div of DIVS) {
          const outcome = await readFrame(page, ws.hash, FIRST_REFERENCE, div)
          if (outcome.kind === 'null') {
            const exists = await fs.access(file).then(() => true, () => false)
            throw new Error(`${label}, div ${div}: the reader missed a stored frame (file ${exists ? 'present' : 'deleted'})`)
          }
          expectPixels(outcome, reference(PROBE, div), RULE[lane], `${label}, div ${div}`)
        }
      }
      await readAll('before any reload')
      const utility = lane !== 'texture'
      const pid = utility ? await eventually(() => readerPid(app), `no "${READER_SERVICE}" utility process in app.getAppMetrics()`) : null

      for (let round = 1; round <= 3; round++) {
        // The outgoing document leaves a read on its port; the hold keeps it
        // inside the utility past the reload.
        if (utility) {
          await startRead(page, `held-${round}`, ws.hash, HOLD, 1)
          await readAll(`behind the held read, round ${round}`)
          expect(await readState(page, `held-${round}`), `the held read was answered: ${HOLD_HINT}`).toEqual({ state: 'pending' })
        }
        const connects = await connectCount(app)
        await page.reload()
        await waitForHook(page, 'readMotifFrame')
        await readAll(`after reload ${round}`)
        const delta = (await connectCount(app)) - connects
        const stats = await readerStats(page)
        if (utility) {
          // The outgoing document's held read sees its port retired and may
          // reconnect once before it unloads; the new document must read on
          // its first port without a failure or a reconnect.
          expect(delta, `reload ${round}: connects from the outgoing and the new document`).toBeGreaterThanOrEqual(1)
          expect(delta, `reload ${round}: connects from the outgoing and the new document`).toBeLessThanOrEqual(2)
          expect({ transportFailures: stats.transportFailures, restarts: stats.restarts },
            `reload ${round}: the new document reads without a transport failure`).toEqual({ transportFailures: 0, restarts: 0 })
          expect(await readerPid(app), `reload ${round}: one utility process serves every document`).toBe(pid)
        } else {
          expect(delta, `reload ${round}: the texture lane never connects to the utility`).toBe(0)
        }
      }

      if (utility) {
        // Release the outgoing documents' reads: their replies go to retired
        // ports and are dropped, without disturbing the current document.
        const connects = await connectCount(app)
        expect((await readFrame(page, ws.hash, RELEASE, 1, false)).kind, 'the release frame is absent: a miss').toBe('null')
        await readAll('after the retired ports\' reads finished')
        expect((await connectCount(app)) - connects, 'the current port survives replies to retired ones').toBe(0)
        expect(await readerPid(app), 'the utility survives replies to retired ports').toBe(pid)
      }
    } finally { await app.close() }
  })
}
