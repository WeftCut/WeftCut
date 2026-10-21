// apps/desktop/src/main/mcp/server.taste.test.ts
// `project://taste` and `read_project { view: "taste" }` serve the host's
// merged taste view, the same record both ways, and both answer on the start
// screen (the default style alone) like the session view does.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('../motif/capture.js', () => ({ captureMotifFrameB64: async () => '' }))

import { handleCallTool, handleReadResource } from './server'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const VIEW = { style: { name: 'weftcut-default' }, tokens: { text: {} }, revision: 'r1' }

function host(open: boolean) {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'taste'), idGen, clock: () => '<TS>' })
  return {
    actor, mcpCall: (n: string, a: string) => actor.mcpCall(n, a),
    openedProject: () => (open ? { dir: '/p' } : null),
    taste: () => VIEW,
    motifTool: () => [], handleInvoke: async () => null, start: () => {}, stop: () => {},
  } as any
}
const backend = { mcpCallTool: async () => { throw new Error('rust must not be called') }, mcpReadResource: async () => { throw new Error('rust must not be called') }, mcpCatalog: async () => RUST_CATALOG } as any

describe('the taste view', () => {
  for (const open of [true, false]) {
    it(`answers the same record as a tool and as a resource (${open ? 'project open' : 'start screen'})`, async () => {
      const h = host(open)
      const tool = await handleCallTool(backend, () => h, 'read_project', { view: 'taste' }) as { isError?: boolean; content: Array<{ text: string }> }
      expect(tool.isError).toBeFalsy()
      expect(JSON.parse(tool.content[0]!.text)).toEqual(VIEW)
      const res = await handleReadResource(backend, () => h, 'project://taste') as unknown as { contents: Array<{ text: string }> }
      expect(JSON.parse(res.contents[0]!.text)).toEqual(VIEW)
    })
  }
})
