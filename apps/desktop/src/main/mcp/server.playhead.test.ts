// `project://playhead` / `read_project { view: "playhead" }` over the MCP
// surface: the resource and the tool answer the same record, the editor is
// asked only when someone reads, and every refusal names its cause.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { handleCallTool, handleReadResource } from './server'
import { PlayheadReader, playheadView } from './playheadView'
import { createActor } from '../state/actor'
import { groupedProject } from '../state/__tests__/fixtures/project'
import type { EditorPlayheadReport, PlayheadReadMessage } from '../../shared/editorPlayhead'

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')

/** A host whose editor answers with `editor()` (a report, an error string, or
 *  nothing at all for a window that is gone), wired the way the app wires it. */
function host(editor: () => EditorPlayheadReport | string | null, opened = true) {
  const { p, idGen, groupId, innerId } = groupedProject()
  const actor = createActor({ initial: p, idGen, clock: () => '<TS>' })
  const asked: PlayheadReadMessage[] = []
  const reader = new PlayheadReader({
    ask: (m) => {
      const answer = editor()
      if (answer === null) return false
      asked.push(m)
      queueMicrotask(() => reader.answer(typeof answer === 'string' ? { request_id: m.request_id, error: answer } : { request_id: m.request_id, report: answer }))
      return true
    },
  })
  const ts = {
    actor,
    mcpCall: (name: string, argsJson: string) => actor.mcpCall(name, argsJson),
    openedProject: () => (opened ? { dir: '/home/u/film' } : null),
    playhead: async () => playheadView(actor.snapshot(), await reader.read()),
    motifTool: () => [], handleInvoke: async () => null, start: () => {}, stop: () => {},
  } as any
  const backend = { mcpCallTool: async () => { throw new Error('rust must not be called') }, mcpReadResource: async () => { throw new Error('rust must not be called') }, mcpCatalog: async () => RUST_CATALOG } as any
  return { p, groupId, innerId, asked, ts, backend }
}

type Res = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }

describe('the playhead read', () => {
  it('answers the same record as a tool and as a resource, naming the clip under the playhead', async () => {
    let report: EditorPlayheadReport | null = null
    const h = host(() => report)
    report = { root_id: h.p.root_id, composition_id: h.groupId, t_us: 400_000, timecode: '00:00:00:12', playing: false, range: null, selection: [h.innerId] }
    const tool = await handleCallTool(h.backend, () => h.ts, 'read_project', { view: 'playhead' }) as Res
    expect(tool.isError).toBeFalsy()
    const res = await handleReadResource(h.backend, () => h.ts, 'project://playhead') as { contents: Array<{ text: string; mimeType: string }> }
    expect(JSON.parse(res.contents[0]!.text)).toEqual(JSON.parse(tool.content[0]!.text))
    expect(JSON.parse(tool.content[0]!.text)).toMatchObject({
      composition_id: h.groupId, t_us: 400_000, selection: [h.innerId],
      under_playhead: [expect.objectContaining({ layer_id: h.innerId })],
    })
    expect(h.asked).toHaveLength(2)
  })

  it('asks the editor nothing until something reads', async () => {
    const editor = vi.fn(() => null)
    const h = host(editor)
    await handleCallTool(h.backend, () => h.ts, 'read_project', { view: 'tracks' })
    await handleReadResource(h.backend, () => h.ts, 'project://tracks')
    expect(editor).not.toHaveBeenCalled()
  })

  it('is refused with NoProjectOpen on the start screen, without asking the editor', async () => {
    const editor = vi.fn(() => null)
    const h = host(editor, false)
    const tool = await handleCallTool(h.backend, () => h.ts, 'read_project', { view: 'playhead' }) as Res
    expect(tool.structuredContent).toMatchObject({ code: 'invalid_request', error: 'NoProjectOpen' })
    await expect(handleReadResource(h.backend, () => h.ts, 'project://playhead')).rejects.toThrow(/No project is open/)
    expect(editor).not.toHaveBeenCalled()
  })

  it('is refused with EditorNotReady when the editor has no window or no project loaded', async () => {
    let answer: string | null = null
    const h = host(() => answer)
    const gone = await handleCallTool(h.backend, () => h.ts, 'read_project', { view: 'playhead' }) as Res
    expect(gone.structuredContent).toMatchObject({ code: 'invalid_request', error: 'EditorNotReady' })
    answer = 'The editor has not loaded the project yet; retry in a moment.'
    const loading = await handleCallTool(h.backend, () => h.ts, 'read_project', { view: 'playhead' }) as Res
    expect(loading.structuredContent).toMatchObject({ error: 'EditorNotReady' })
    expect(loading.content[0]!.text).toContain('has not loaded the project')
    await expect(handleReadResource(h.backend, () => h.ts, 'project://playhead')).rejects.toMatchObject({ data: { error: 'EditorNotReady' } })
  })

  it('is refused with EditorNotReady by a host built without an editor', async () => {
    const h = host(() => null)
    delete h.ts.playhead
    const tool = await handleCallTool(h.backend, () => h.ts, 'read_project', { view: 'playhead' }) as Res
    expect(tool.structuredContent).toMatchObject({ error: 'EditorNotReady' })
  })

  it('refuses arguments the view does not take', async () => {
    const h = host(() => null)
    const tool = await handleCallTool(h.backend, () => h.ts, 'read_project', { view: 'playhead', composition_id: h.groupId }) as Res
    expect(tool.structuredContent).toMatchObject({ code: 'invalid_params' })
  })
})
