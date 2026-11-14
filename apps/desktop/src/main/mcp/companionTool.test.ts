// `open_companion` through the MCP dispatcher: the link the host was started
// with, on the start screen as in a project.
import { describe, expect, it } from 'vitest'
import { handleCallTool } from './server'

const LINK = `http://127.0.0.1:1/companion#k=${'0'.repeat(64)}`
const backend = { mcpCallTool: async () => { throw new Error('open_companion must not reach the backend') } } as never
const noProject = () => ({ openedProject: () => null }) as never

const call = (args: Record<string, unknown>, link: string | null) =>
  handleCallTool(backend, noProject, 'open_companion', args, undefined, undefined, undefined, undefined, undefined, undefined, link) as Promise<any>

describe('open_companion', () => {
  it('answers the link, with no project open', async () => {
    const out = await call({}, LINK)
    expect(out.isError).toBeFalsy()
    expect(out.structuredContent).toEqual({ url: LINK })
  })

  it('is refused where no listener serves the page', async () => {
    const out = await call({}, null)
    expect(out.isError).toBe(true)
    expect(out.structuredContent).toMatchObject({ code: 'invalid_request', error: 'CompanionUnavailable' })
  })

  it('takes no arguments', async () => {
    const out = await call({ open: true }, LINK)
    expect(out.isError).toBe(true)
    expect(out.structuredContent).toMatchObject({ code: 'invalid_params' })
  })
})
