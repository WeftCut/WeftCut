// apps/desktop/src/main/mcp/server.preview.test.ts
// `preview_motif_draft` renders what `add_motif_layer` would place: the props
// go through the same canonicaliser the placement uses, so an omitted prop
// takes its manifest default (a lower third previews WITH its text), and an
// unknown id or prop is refused before any capture.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const capture = vi.fn(async (_args: unknown) => 'iVBOR')
vi.mock('../motif/capture.js', () => ({ captureMotifFrameB64: (args: unknown) => capture(args) }))

import { handleCallTool } from './server'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'
import { root } from '../state/__tests__/fixtures/project'

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const CATALOG = [{
  id: 'lower-third', name: 'Lower third', version: 1, size: [1920, 1080], default_duration_s: 5, fonts: [],
  props_schema: { title: { type: 'string', default: 'Name Surname' }, subtitle: { type: 'string', default: 'Role' } },
  status: 'builtin', html: '<x>', content_hash: 'h', has_params_ui: false,
}]

function host() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'preview'), idGen, clock: () => '<TS>' })
  return {
    actor, mcpCall: (n: string, a: string) => actor.mcpCall(n, a),
    hybridDeps: { actor, compute: {}, enqueueDerivatives: vi.fn(), enqueueWorkspaceCopy: vi.fn(), workspaceDir: () => null, readFile: () => '', snapshotComposition: () => root(actor.snapshot()) },
    motifTool: (name: string) => (name === 'list_motifs' ? CATALOG : null),
    handleInvoke: async () => null, start: () => {}, stop: () => {},
  } as any
}
const backend = { mcpCallTool: async () => { throw new Error('rust must not be called') }, mcpReadResource: async () => '{}', mcpCatalog: async () => RUST_CATALOG } as any
type Res = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }> }

describe('preview_motif_draft renders what add_motif_layer would place', () => {
  it('omitted props take the manifest defaults, and the size is the motif\'s own', async () => {
    capture.mockClear()
    const out = await handleCallTool(backend, host, 'preview_motif_draft', { id: 'lower-third', t_sec: 1 }) as Res
    expect(out.isError).toBeFalsy()
    expect(out.content[0]).toMatchObject({ type: 'image', data: 'iVBOR' })
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      motifId: 'lower-third', tSec: 1, width: 1920, height: 1080,
      propsJson: JSON.stringify({ subtitle: 'Role', title: 'Name Surname' }),
    }))
  })

  it('a partial props object is filled from the defaults', async () => {
    capture.mockClear()
    await handleCallTool(backend, host, 'preview_motif_draft', { id: 'lower-third', t_sec: 0, props: { title: 'Ada' } })
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ propsJson: JSON.stringify({ subtitle: 'Role', title: 'Ada' }) }))
  })

  it('an unknown prop is refused naming it, before any capture', async () => {
    capture.mockClear()
    const out = await handleCallTool(backend, host, 'preview_motif_draft', { id: 'lower-third', t_sec: 0, props: { titel: 'x' } }) as Res
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('titel')
    expect(out.content[0].text).toContain('props_schema')
    expect(capture).not.toHaveBeenCalled()
  })

  it('an unknown motif id is refused naming list_motifs, before any capture', async () => {
    capture.mockClear()
    const out = await handleCallTool(backend, host, 'preview_motif_draft', { id: 'title-card', t_sec: 0 }) as Res
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain("'title-card'")
    expect(out.content[0].text).toContain('list_motifs')
    expect(capture).not.toHaveBeenCalled()
  })
})
