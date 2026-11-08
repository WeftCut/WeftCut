// apps/desktop/src/main/mcp/server.preview.test.ts
// `preview_motif` renders what `add_layers` (kind motif) would place: the props
// go through the same canonicaliser the placement uses, so an omitted prop
// takes its manifest default (a lower third previews WITH its text), and an
// unknown id or prop is refused before any capture. Every requested time
// comes back on one labelled contact sheet (ME6), and only the requested Motif
// is read (ME18: no catalog listing, so no sync of every linked draft).
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { decodePng, encodePng } from './motifSheet'

/** A capture of the size it was asked for, one colour, as base64 PNG. */
function frame(args: { width: number; height: number; scale?: number }): string {
  const w = Math.round(args.width * (args.scale ?? 1)), h = Math.round(args.height * (args.scale ?? 1))
  return Buffer.from(encodePng({ width: w, height: h, pixels: new Uint8Array(w * h * 4).fill(200) })).toString('base64')
}
const capture = vi.fn(async (args: { width: number; height: number; scale?: number }) => frame(args))

import { handleCallTool } from './server'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'
import { root } from '../state/__tests__/fixtures/project'

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const MANIFEST = {
  id: 'lower-third', name: 'Lower third', version: 1, size: [1920, 1080], default_duration_s: 5, fonts: [],
  props_schema: { title: { type: 'string', default: 'Name Surname' }, subtitle: { type: 'string', default: 'Role' } },
}

const reads: string[] = []
function host() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'preview'), idGen, clock: () => '<TS>' })
  return {
    actor, mcpCall: (n: string, a: string) => actor.mcpCall(n, a),
    hybridDeps: { actor, compute: {}, enqueueDerivatives: vi.fn(), enqueueWorkspaceCopy: vi.fn(), workspaceDir: () => null, readFile: () => '', snapshotComposition: () => root(actor.snapshot()) },
    motifTool: (name: string, args: { motif_id?: string }) => {
      reads.push(name)
      if (name !== 'read_motif') return null
      if (args.motif_id !== 'lower-third') throw new Error(`unknown motif id '${args.motif_id}'`)
      return { manifest: MANIFEST, revision: 'rev-1', status: 'builtin' }
    },
    handleInvoke: async () => null, start: () => {}, stop: () => {},
  } as any
}
const backend = { mcpCallTool: async () => { throw new Error('rust must not be called') }, mcpReadResource: async () => '{}', mcpCatalog: async () => RUST_CATALOG } as any
type Res = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }
const record = (out: Res) => JSON.parse(out.content[1]!.text!)
/** `preview_motif` through the call funnel; `capture` records each frame's arguments. */
const preview = (args: Record<string, unknown>) => handleCallTool(backend, host, 'preview_motif', args, undefined, undefined, undefined, undefined, undefined, frameArgs => capture(frameArgs))
const sheetOf = (out: Res) => decodePng(new Uint8Array(Buffer.from(out.content[0]!.data!, 'base64')))

describe('preview_motif renders what add_layers would place', () => {
  it('omitted props take the manifest defaults; a frame is 640 wide by default; one Motif is read', async () => {
    capture.mockClear(); reads.length = 0
    const out = await preview({ motif_id: 'lower-third', local_t_s: [1] }) as Res
    expect(out.isError).toBeFalsy()
    expect(out.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      motifId: 'lower-third', tSec: 1, width: 1920, height: 1080, scale: 1 / 3, contentHash: 'rev-1',
      propsJson: JSON.stringify({ subtitle: 'Role', title: 'Name Surname' }),
    }))
    expect(record(out)).toMatchObject({ motif_id: 'lower-third', revision: 'rev-1', canvas: [1920, 1080], image: [640, 360], local_t_s: [1], sheet: { width: 640, height: 386, columns: 1 } })
    // ME18: no catalog listing (which syncs every linked draft), one read.
    expect(reads).toEqual(['read_motif'])
  })

  it('every time lands on one labelled contact sheet, in order, up to four columns (ME6)', async () => {
    capture.mockClear()
    const times = [0, 0.5, 1, 2, 3, 4.5]
    const out = await preview({ motif_id: 'lower-third', local_t_s: times }) as Res
    expect(out.content.filter((c) => c.type === 'image')).toHaveLength(1)
    expect(capture.mock.calls.map((c) => (c[0] as unknown as { tSec: number }).tSec)).toEqual(times)
    expect(record(out).sheet).toEqual({ width: 4 * 640, height: 2 * (360 + 26), columns: 4 })
    const sheet = sheetOf(out)
    expect([sheet.width, sheet.height]).toEqual([2560, 772])
    // A cell keeps the frame's own pixels under its label strip.
    const at = (x: number, y: number) => Array.from(sheet.pixels.subarray((y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 4))
    expect(at(700, 26 + 10)).toEqual([200, 200, 200, 200])
    expect(at(700 + 200, 2)).toEqual([30, 30, 30, 255])
  })

  it('a requested size scales the whole canvas to fit; it never crops', async () => {
    capture.mockClear()
    const out = await preview({ motif_id: 'lower-third', local_t_s: [1], width: 640, height: 640 }) as Res
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ width: 1920, height: 1080, scale: 1 / 3 }))
    expect(record(out)).toMatchObject({ canvas: [1920, 1080], image: [640, 360] })
    capture.mockClear()
    await preview({ motif_id: 'lower-third', local_t_s: [1], width: 960 })
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ width: 1920, height: 1080, scale: 0.5 }))
    capture.mockClear()
    await preview({ motif_id: 'lower-third', local_t_s: [1], width: 7680, height: 4320 })
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ width: 1920, height: 1080, scale: 2 }))
  })

  it('a partial props object is filled from the defaults', async () => {
    capture.mockClear()
    await preview({ motif_id: 'lower-third', local_t_s: [0], props: { title: 'Ada' } })
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ propsJson: JSON.stringify({ subtitle: 'Role', title: 'Ada' }) }))
  })

  it('an unknown prop is refused naming it, before any capture', async () => {
    capture.mockClear()
    const out = await preview({ motif_id: 'lower-third', local_t_s: [0], props: { titel: 'x' } }) as Res
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('titel')
    expect(out.content[0].text).toContain('props_schema')
    expect(capture).not.toHaveBeenCalled()
  })

  it('an unknown motif id is refused naming list_motifs, before any capture', async () => {
    capture.mockClear()
    const out = await preview({ motif_id: 'title-card', local_t_s: [0] }) as Res
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain("'title-card'")
    expect(out.content[0].text).toContain('list_motifs')
    expect(capture).not.toHaveBeenCalled()
  })

  it('a stale expected_revision names the current one, before any capture (ME19)', async () => {
    capture.mockClear()
    const out = await preview({ motif_id: 'lower-third', local_t_s: [0], expected_revision: 'old' }) as Res & { structuredContent: Record<string, unknown> }
    expect(out.isError).toBe(true)
    expect(out.structuredContent).toMatchObject({ error: 'RevisionConflict', current_revision: 'rev-1' })
    expect(capture).not.toHaveBeenCalled()
  })

  it('a call without local_t_s, with a scalar, or with an argument it does not take, is refused before any capture', async () => {
    capture.mockClear()
    const plural = await preview({ motif_id: 'lower-third', times_s: [0.5, 2] }) as Res
    expect(plural.isError).toBe(true)
    expect(plural.content[0].text).toContain('times_s')
    const bare = await preview({ motif_id: 'lower-third' }) as Res
    expect(bare.isError).toBe(true)
    expect(bare.content[0].text).toContain('local_t_s')
    const scalar = await preview({ motif_id: 'lower-third', local_t_s: 1 }) as Res
    expect(scalar.isError).toBe(true)
    expect(scalar.content[0].text).toContain('local_t_s')
    const empty = await preview({ motif_id: 'lower-third', local_t_s: [] }) as Res
    expect(empty.isError).toBe(true)
    expect(capture).not.toHaveBeenCalled()
  })
})
