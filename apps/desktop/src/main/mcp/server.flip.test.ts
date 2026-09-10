import { describe, it, expect, vi } from 'vitest'
import { callClipComputeTool, handleCallTool } from './server'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'
import { mediaItemTemplate } from '../state/mutations/media'
import { root } from '../state/__tests__/fixtures/project'
import { assertModelsIdle } from '../model-usage'

const MID = '00000000-0000-0000-0000-0000000000aa'

function tsHostStub() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'flip'), idGen, clock: () => '<TS>' })
  // Minimal hybridDeps: fake compute + spy enqueues, no workspace.
  const hybridDeps = {
    actor,
    compute: {
      probeMedia: vi.fn(async () => JSON.stringify(mediaItemTemplate(MID, 'Video', 4_000_000))),
      hashMediaSource: vi.fn(async () => 'h'),
      parseSubtitles: vi.fn(), synthesizeSpeechCompute: vi.fn(),
    },
    enqueueDerivatives: vi.fn(async () => {}),
    enqueueWorkspaceCopy: vi.fn(async () => {}),
    workspaceDir: () => null,
    readFile: () => '',
    snapshotComposition: () => root(actor.snapshot()),
  }
  return { actor, mcpCall: (name: string, argsJson: string) => actor.mcpCall(name, argsJson), hybridDeps, handleInvoke: async () => null, start: () => {}, stop: () => {}, beginAgentSessionSlot: () => {} } as any
}
function fakeBackend(mcpCallTool: (n: string, a: string) => Promise<string>) {
  return { mcpCallTool, mcpReadResource: async () => '{"ok":true,"result":{}}', mcpCatalog: async () => '{"tools":[]}' } as any
}

describe('handleCallTool flip routing', () => {
  it('holds model files until native inference ends, including a rejected run', async () => {
    let reject!: (reason: Error) => void;
    const native = new Promise<string>((_resolve, fail) => { reject = fail });
    const run = callClipComputeTool(fakeBackend(() => native), tsHostStub(), 'transcribe_clip', { layer_id: 'gone' });
    expect(() => assertModelsIdle()).toThrow('in use');
    reject(new Error('cancelled'));
    await expect(run).rejects.toThrow('cancelled');
    expect(() => assertModelsIdle()).not.toThrow();
  });
  it('routes a mutation tool to the TS actor (state changes)', async () => {
    const ts = tsHostStub()
    const track = root(ts.actor.snapshot()).tracks[0].id
    const out: any = await handleCallTool(fakeBackend(async () => { throw new Error('rust must not be called') }), () => ts, 'add_color_layer', { track_id: track, color: { r: 0, g: 0, b: 0, a: 1 }, t_start_us: 0, t_end_us: 1_000_000 })
    expect(out.content[0].type).toBe('text') // a uuid
    const layers = root(ts.actor.snapshot()).tracks.reduce((n: number, t: any) => n + t.layers.length, 0)
    expect(layers).toBe(1)
  })
  it('routes synthesize_speech through the hybrid (not blocked)', async () => {
    // synthesize_speech is a hybrid; it must NOT be rejected with -32600.
    // The fake synthesizeSpeechCompute returns '{}'  (no media_item)
    // so the arm throws an actor-write error — but NOT a -32600 blocked rejection.
    const ts = tsHostStub()
    const result = await handleCallTool(fakeBackend(async () => '{}'), () => ts, 'synthesize_speech', { text: 'hi' })
      .then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e }))
    // Must NOT have been rejected with code -32600 (that is the blocked path).
    if (!result.ok) {
      expect((result.e as { code?: number }).code).not.toBe(-32600)
    }
    // The hybrid path was entered (compute was called even though it returned '{}'
    // which causes a downstream throw; what matters is -32600 is not raised).
    expect(ts.hybridDeps.compute.synthesizeSpeechCompute).toHaveBeenCalled()
  })
  it('routes import_media through the hybrid (TS-write), returning the media id as text', async () => {
    const ts = tsHostStub()
    const out: any = await handleCallTool(fakeBackend(async () => { throw new Error('rust must not be called') }), () => ts, 'import_media', { path: 'C:/x.mp4' })
    expect(out.content[0]).toEqual({ type: 'text', text: MID })
    expect(ts.actor.snapshot().media_pool[MID]).toBeTruthy()
    expect(ts.hybridDeps.enqueueDerivatives).toHaveBeenCalledTimes(1)
  })
  it('forwards a plain rust-routed tool to the backend', async () => {
    // ping is the one live rust-native tool with no clip-slice injection — it falls
    // straight through to the backend.
    const ts = tsHostStub()
    const spy = vi.fn(async () => '{"ok":true,"result":{"content":[{"type":"text","text":"pong"}]}}')
    await handleCallTool(fakeBackend(spy), () => ts, 'ping', {})
    expect(spy).toHaveBeenCalledWith('ping', JSON.stringify({}))
  })
  it('no tsHost → forwards everything to the backend', async () => {
    const spy = vi.fn(async () => '{"ok":true,"result":{"content":[]}}')
    await handleCallTool(fakeBackend(spy), () => null, 'add_color_layer', {})
    expect(spy).toHaveBeenCalled()
  })
  it('resolves the { layer, media } slice for a clip-audio tool and forwards it to the backend', async () => {
    const ts = tsHostStub()
    const spy = vi.fn((_name: string, _args: string) =>
      Promise.resolve('{"ok":true,"result":{"content":[{"type":"text","text":"[]"}]}}'),
    )
    await handleCallTool(fakeBackend(spy), () => ts, 'detect_pauses', { layer_id: 'gone' })
    expect(spy).toHaveBeenCalledTimes(1)
    const merged = JSON.parse(spy.mock.calls[0][1])
    // The slice was resolved + merged (the intercept ran); 'gone' is not in the
    // blank project, so both are null — Rust then produces "layer not found".
    expect('layer' in merged).toBe(true)
    expect('media' in merged).toBe(true)
    expect(merged.layer).toBeNull()
    expect(merged.media).toBeNull()
    expect(merged.layer_id).toBe('gone')
  })
  // Decision 11: the detection reads whatever the mixer plays, so the host
  // resolves the fx sibling's peaks file and injects it beside the slice. A
  // build with no baker injects null and Rust reads the media's own peaks —
  // the same fallback a not-yet-baked layer takes.
  it('injects the resolved fx peaks path for detect_pauses, and null without a baker', async () => {
    const ts = tsHostStub()
    const track = root(ts.actor.snapshot()).tracks[1].id
    const AID = '00000000-0000-0000-0000-0000000000dd'
    ts.actor.dispatch('add_media', { id: AID, kind: 'Audio', duration_us: 4_000_000 })
    const add = ts.actor.dispatch('add_layer', { track, kind: 'audio', media: AID,
      src_in_us: 0, src_out_us: 4_000_000, t_start_us: 0, t_end_us: 4_000_000 })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const layerId = add.value as string
    const spy = vi.fn(okEnvelope)
    const peaksPathFor = vi.fn(() => 'C:/cache/fx/abc.peaks')
    await handleCallTool(fakeBackend(spy), () => ts, 'detect_pauses', { layer_id: layerId },
      () => null, undefined, peaksPathFor)
    expect(peaksPathFor).toHaveBeenCalledWith(layerId)
    expect(JSON.parse(spy.mock.calls[0][1]).peaks_path).toBe('C:/cache/fx/abc.peaks')
    await handleCallTool(fakeBackend(spy), () => ts, 'detect_pauses', { layer_id: layerId })
    expect(JSON.parse(spy.mock.calls[1][1]).peaks_path).toBeNull()
  })
  it('begins work through the session service when the host provides it', async () => {
    const ts = tsHostStub()
    const begin = vi.fn(() => ({ id: 'session' }))
    ;(ts as any).agent = { begin }
    await handleCallTool(fakeBackend(async () => { throw new Error('rust must not be called') }), () => ts, 'begin_agent_session', { reason: 'cleanup' })
    expect(begin).toHaveBeenCalledWith('cleanup')
  })
  // ADR 0036: transcribe_clip selects by user preference THEN availability.
  // The host injects the stored preferred engine as the SOFT `preferred_backend`
  // hint when the agent omits `backend`; the agent's explicit `backend` is a
  // STRICT Rust-side override and must pass through untouched (and suppress the
  // preference injection); "auto" defers to the Rust resolver.
  const okEnvelope = (_n: string, _a: string) => Promise.resolve('{"ok":true,"result":{"content":[{"type":"text","text":"{}"}]}}')
  it('injects the preferred engine as preferred_backend when the agent omits backend', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(okEnvelope)
    await handleCallTool(fakeBackend(spy), () => ts, 'transcribe_clip', { layer_id: 'gone' }, () => 'whisper_cpp')
    const sent = JSON.parse(spy.mock.calls[0][1])
    expect(sent.preferred_backend).toBe('whisper_cpp')
    expect(sent.backend).toBeUndefined() // never promoted to the strict arg
  })
  it('passes an explicit transcribe_clip backend through untouched and injects no preference', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(okEnvelope)
    await handleCallTool(fakeBackend(spy), () => ts, 'transcribe_clip', { layer_id: 'gone', backend: 'openai' }, () => 'whisper_cpp')
    const sent = JSON.parse(spy.mock.calls[0][1])
    expect(sent.backend).toBe('openai')
    expect(sent.preferred_backend).toBeUndefined()
  })
  it('injects nothing when the preferred engine is auto', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(okEnvelope)
    await handleCallTool(fakeBackend(spy), () => ts, 'transcribe_clip', { layer_id: 'gone' }, () => 'auto')
    const sent = JSON.parse(spy.mock.calls[0][1])
    expect(sent.backend).toBeUndefined()
    expect(sent.preferred_backend).toBeUndefined()
  })

  // The renderer's `clipCompute` route calls this function directly (index.ts),
  // so the two surfaces are one code path by construction rather than by
  // convention. Driven here beside the MCP cases: what the gate has to hold is
  // that the SAME arguments come out either way, injection included.
  it('resolves the slice and injects the same hints when called directly', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(okEnvelope)
    await callClipComputeTool(fakeBackend(spy), ts, 'transcribe_clip', { layer_id: 'gone' }, () => 'whisper_cpp')
    const sent = JSON.parse(spy.mock.calls[0][1])
    expect(sent.preferred_backend).toBe('whisper_cpp')
    // The slice keys the stateless Rust handler reads, present (null for a layer
    // the actor does not hold — Rust owns the not-found refusal).
    expect(sent).toHaveProperty('layer')
    expect(sent).toHaveProperty('media')
  })
  it('injects the VLM config snapshot when called directly for describe_clip', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(okEnvelope)
    await callClipComputeTool(
      fakeBackend(spy), ts, 'describe_clip', { layer_id: 'gone' },
      () => null,
      () => ({
        config: { qwen3_vl: { binary: 'q' } },
        preferred: 'qwen3_vl',
        language: 'zh-CN',
        fps: 2.5,
        focus: 'shot-type',
      }),
    )
    const sent = JSON.parse(spy.mock.calls[0][1])
    expect(sent.vlm_config).toEqual({ qwen3_vl: { binary: 'q' } })
    expect(sent.preferred_backend).toBe('qwen3_vl')
    // The whole VIEW rides in with the config: the description cache is keyed by
    // all three, so the tool that writes an entry and the resource that reads
    // one have to name the same one.
    expect(sent.language).toBe('zh-CN')
    expect(sent.fps).toBe(2.5)
    expect(sent.focus).toBe('shot-type')
  })

  // `language` is ADVERTISED, unlike `preferred_backend`: an agent may want
  // Japanese prose about a clip whatever the app's chrome is set to, so the
  // injection fills an unset one and never overrules a stated one.
  it('leaves an explicitly requested describe language alone', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(okEnvelope)
    await callClipComputeTool(
      fakeBackend(spy), ts, 'describe_clip', { layer_id: 'gone', language: 'ja' },
      () => null,
      () => ({ config: {}, preferred: null, language: 'zh-CN', fps: 1, focus: 'general' }),
    )
    expect(JSON.parse(spy.mock.calls[0][1]).language).toBe('ja')
  })

  // Same rule for the other two axes, and it has to hold for the same reason:
  // an agent that asked to sample densely, or for camera-focused tags, keeps
  // what it asked for whatever the app's panel is set to.
  it('leaves an explicitly requested sampling and focus alone', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(okEnvelope)
    await callClipComputeTool(
      fakeBackend(spy), ts, 'describe_clip', { layer_id: 'gone', fps: 4, focus: 'general' },
      () => null,
      () => ({ config: {}, preferred: null, language: null, fps: 1, focus: 'shot-type' }),
    )
    const sent = JSON.parse(spy.mock.calls[0][1])
    expect(sent.fps).toBe(4)
    expect(sent.focus).toBe('general')
  })

  // No UI to speak for → nothing injected, so Rust's own default decides. The
  // `detectPauses` rule: one statement of a default, on the side that owns it.
  it('injects no describe language when the provider has none', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(okEnvelope)
    await callClipComputeTool(
      fakeBackend(spy), ts, 'describe_clip', { layer_id: 'gone' },
      () => null,
      () => ({ config: {}, preferred: null, language: null, fps: null, focus: null }),
    )
    const sent = JSON.parse(spy.mock.calls[0][1])
    expect(sent.language).toBeUndefined()
    expect(sent.fps).toBeUndefined()
    expect(sent.focus).toBeUndefined()
  })
})
