// apps/desktop/src/main/mcp/server.audit.test.ts
// The audit over the tool surface (spec H1-D5/D6): `check_composition` checks
// against the project's taste and the host remembers it. The session's end
// audits work not checked since its last change, from the app's own record
// rather than the agent's account, and holds the session once for hard or
// warning findings the agent has not seen.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { handleCallTool } from './server'
import { AgentActivityService } from '../agent/activity'
import { AuditStore } from '../lint/audits'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'
import { root } from '../state/__tests__/fixtures/project'
import { tasteView } from '../taste/view'

const RUST_CATALOG = readFileSync('fixtures/mcp/rust-catalog-snapshot.json', 'utf8')
const BUILTIN = path.join(import.meta.dirname, '../../shared/styles/builtin')

function host() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'audit'), idGen, clock: () => '<TS>' })
  const agent = new AgentActivityService(actor, vi.fn())
  agent.start()
  const ts = {
    actor, agent, audits: new AuditStore(), taste: () => tasteView({ builtin: BUILTIN, user: null }, null),
    mcpCall: (name: string, argsJson: string) => actor.mcpCall(name, argsJson),
    hybridDeps: { actor, compute: {}, enqueueDerivatives: vi.fn(), enqueueWorkspaceCopy: vi.fn(), workspaceDir: () => null, readFile: () => '', snapshotComposition: () => root(actor.snapshot()) },
    motifTool: () => [], handleInvoke: async () => null, start: () => {}, stop: () => {},
  } as any
  const backend = { mcpCallTool: async () => { throw new Error('rust must not be called') }, mcpReadResource: async () => '{"ok":true,"result":{}}', mcpCatalog: async () => RUST_CATALOG } as any
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await agent.run('one', 'client-one', name, args, false, () => handleCallTool(backend, () => ts, name, args)) as { isError?: boolean; content: Array<{ text: string }> }
    const text = r.content[0]!.text
    if (r.isError) return { isError: true, body: { text } as Record<string, any> }
    return { isError: r.isError, body: JSON.parse(text) as Record<string, any> }
  }
  const bRoll = root(actor.snapshot()).tracks[1]!.id
  return { call, bRoll }
}

describe('check_composition and audit freshness', () => {
  it('finds a short title against the style; the session end audits work nobody checked, once', async () => {
    const { call, bRoll } = host()
    await call('begin_agent_session', { reason: 'titles' })
    const added = await call('add_text_layer', { track_id: bRoll, content: 'Title', t_start_us: 0, t_end_us: 2_000_000 })
    expect(added.isError).toBeFalsy()
    await call('update_layer_params', { layer_id: added.body.layer_id, patch: { kind: 'Text', graphic_role: 'title' } })

    // Never audited: the end runs the audit, and its warnings hold the session.
    const held = await call('end_agent_session')
    expect(held.body).toMatchObject({ ended: null, held: 'audit', audit: { state: 'fresh', hard: 0 } })
    expect(held.body.audit.findings.map((f: { rule: string }) => f.rule)).toEqual(expect.arrayContaining(['title-hold', 'text-pops']))
    expect(held.body.next).toMatch(/call end_agent_session again/)
    // Seen and unchanged: the next end goes through.
    const ended = await call('end_agent_session')
    expect(ended.body.ended).toMatchObject({ reason: 'titles' })
    expect(ended.body.audit).toMatchObject({ state: 'fresh', warning: held.body.audit.warning })

    // Checked by the agent itself: no hold.
    await call('begin_agent_session', { reason: 'titles' })
    const checked = await call('check_composition')
    expect(checked.isError).toBeFalsy()
    const fresh = await call('end_agent_session')
    expect(fresh.body.ended).not.toBeNull()
    expect(fresh.body.audit).toMatchObject({ state: 'fresh', hard: 0, warning: checked.body.counts.warning })

    // Changed after its audit: audited again, and held while warnings remain.
    await call('begin_agent_session', { reason: 'fix' })
    const fix = await call('update_layer_params', { layer_id: added.body.layer_id, patch: { kind: 'Text', intro: 'FadeIn', outro: 'FadeOut' } })
    expect(fix.isError, JSON.stringify(fix.body)).toBeFalsy()
    const again = await call('end_agent_session')
    expect(again.body).toMatchObject({ held: 'audit' })
    expect(again.body.audit.findings.map((f: { rule: string }) => f.rule)).toEqual(['title-hold'])
    expect((await call('end_agent_session')).body.ended).not.toBeNull()
  })

  it('ends a clean session in one call, and never holds a takeover', async () => {
    const { call, bRoll } = host()
    await call('begin_agent_session', { reason: 'clean' })
    const clean = await call('end_agent_session')
    expect(clean.body.ended).not.toBeNull()
    expect(clean.body.audit).toMatchObject({ state: 'fresh', hard: 0, warning: 0 })

    await call('begin_agent_session', { reason: 'abandoned' })
    const added = await call('add_text_layer', { track_id: bRoll, content: 'Title', t_start_us: 0, t_end_us: 1_000_000 })
    await call('update_layer_params', { layer_id: added.body.layer_id, patch: { kind: 'Text', graphic_role: 'title' } })
    const forced = await call('end_agent_session', { force: true })
    expect(forced.body.ended).not.toBeNull()
    expect(forced.body.audit).toMatchObject({ state: 'stale' })
  })

  it('narrows the findings to a range but remembers the whole composition, and refuses half a range', async () => {
    const { call, bRoll } = host()
    const a = await call('add_text_layer', { track_id: bRoll, content: 'Early', t_start_us: 0, t_end_us: 1_000_000 })
    const b = await call('add_text_layer', { track_id: bRoll, content: 'Late', t_start_us: 20_000_000, t_end_us: 21_000_000 })
    for (const id of [a.body.layer_id, b.body.layer_id]) await call('update_layer_params', { layer_id: id, patch: { kind: 'Text', graphic_role: 'title' } })
    const narrow = await call('check_composition', { t_start_us: 15_000_000, t_end_us: 30_000_000 })
    expect(narrow.body.findings.every((f: { layers: string[] }) => f.layers.includes(b.body.layer_id))).toBe(true)
    const half = await call('check_composition', { t_start_us: 15_000_000 })
    expect(half.isError).toBe(true)
  })
})
