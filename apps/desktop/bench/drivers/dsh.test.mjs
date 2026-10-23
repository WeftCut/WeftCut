// The dsh driver's run overlay, model routes, prices and usage fold.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isPeak, modelRoute, runPatch, streamUsage } from './dsh.ts'

describe('dsh driver', () => {
  it('names the app as the only MCP server, sets the model and withholds shell, web and subagents', () => {
    const patch = runPatch({ mcp: { url: 'http://127.0.0.1:4000/mcp', bearer_token: 'tok' }, model: 'deepseek-v4-pro' })
    assert.deepEqual(patch[0], { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } })
    assert.deepEqual(patch[1], { id: 'session-log-deepseek', config: { enabled: false } })
    const off = patch.filter((p) => p.disabled).map((p) => p.id)
    for (const id of ['tool-bash', 'tool-web', 'tool-subagent']) assert.ok(off.includes(id), id)
    const mcp = patch.at(-1).insert[0]
    assert.equal(mcp.config.serverName, 'weftcut')
    assert.equal(mcp.config.url, 'http://127.0.0.1:4000/mcp')
    assert.deepEqual(mcp.config.headers, { Authorization: 'Bearer tok' })
    assert.deepEqual(modelRoute('openrouter/qwen-max'), { provider: 'openrouter', model: 'qwen-max' })
  })

  it('folds usage and steps from step_end events, cache reads apart', () => {
    const u = streamUsage([
      '{"type":"status","phase":"step_start","turn":1,"step":1}',
      '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":5673,"outputTokens":2,"cacheReadTokens":0}}',
      '{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":5600}}',
      'not json',
    ])
    assert.deepEqual(u, { input: 11373, cachedInput: 5600, output: 52, steps: 2 })
  })

  it('knows DeepSeek\'s peak hours', () => {
    assert.equal(isPeak(new Date('2026-10-23T02:30:00Z')), true)   // Friday 02:30 UTC
    assert.equal(isPeak(new Date('2026-10-23T05:00:00Z')), false)
    assert.equal(isPeak(new Date('2026-10-24T02:30:00Z')), false)   // Saturday
  })
})
