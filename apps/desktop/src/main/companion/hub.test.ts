// The companion hub: the state a page reads, the demand the editor is told,
// and the readiness handshake that decides whether the player can be driven.
import { describe, expect, it } from 'vitest'
import { CompanionHub, type CompanionViewer } from './hub'
import { createActor } from '../state/actor'
import { blankProject } from '../state/model'
import { uuidV7Gen } from '../state/ids'
import { AGENT_ACTIVITY_EVENT } from '../../shared/agent-activity'
import {
  COMPANION_ATTACH, COMPANION_CONTROL_EVENT, COMPANION_DEMAND_EVENT, COMPANION_DETACH, COMPANION_TRANSPORT,
  type CompanionEventName,
} from '../../shared/companion'

function setup(opened: { dir: string } | null = { dir: '/home/u/Projects/Example cut' }) {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'Example cut'), idGen, clock: () => '<TS>' })
  const sent: Array<[string, unknown]> = []
  let focused = 0
  const hub = new CompanionHub({
    getTsHost: () => ({ actor, openedProject: () => opened }) as never,
    sendToEditor: (event, payload) => { sent.push([event, payload]) },
    focusEditor: () => { focused++ },
    language: () => 'zh-CN',
  })
  return { hub, actor, sent, focused: () => focused }
}

function viewer() {
  const events: Array<[CompanionEventName, unknown]> = []
  const v: CompanionViewer = { send: (event, data) => { events.push([event, data]) } }
  return { v, events }
}

const demands = (sent: Array<[string, unknown]>) => sent.filter(([e]) => e === COMPANION_DEMAND_EVENT).map(([, p]) => p)

describe('the state a page reads', () => {
  it('carries the open project, its root timeline and the app language', () => {
    const { hub, actor } = setup()
    const call = (name: string, args: unknown) => {
      const r = actor.mcpCall(name, JSON.stringify(args))
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      return r.result.structuredContent as Record<string, any>
    }
    const track = call('add_track', { label: 'Sequence' })
    const added = call('add_layers', { layers: [{ track_id: track.track_id, t_start_us: 0, t_end_us: 1_000_000, label: 'Red block', content: { kind: 'color', color: { r: 255, g: 0, b: 0, a: 255 } } }] })
    const s = hub.state()
    expect(s.project).toEqual({ name: 'Example cut' })
    expect(s.language).toBe('zh-CN')
    expect(s.tracks.flatMap((t) => t.clips)).toContainEqual({ layer_id: added.layers[0].layer_id, kind: 'Color', label: 'Red block', t_start_us: 0, t_end_us: 1_000_000 })
  })

  it('carries no project while none is open', () => {
    const { hub } = setup(null)
    expect(hub.state()).toMatchObject({ project: null, composition: null, tracks: [] })
  })
})

describe('the demand the editor is told', () => {
  it('asks for nothing without a page watching, or without an editor to ask', () => {
    const { hub, sent } = setup()
    expect(hub.demand()).toEqual({ watch: false })
    hub.watch(viewer().v)
    // A page alone: no editor is attached, so nothing is sent and nothing watched.
    expect(hub.demand()).toEqual({ watch: false })
    expect(sent).toEqual([])
  })

  it('gives a page that opened before the attach in the attach reply, and only changes after it', () => {
    const { hub, sent } = setup()
    const close = hub.watch(viewer().v)
    expect(hub.handleInvoke(COMPANION_ATTACH, { token: 'T1' })).toEqual({ demand: { watch: true } })
    expect(demands(sent)).toEqual([])
    const second = hub.watch(viewer().v)
    expect(demands(sent)).toEqual([])
    close()
    second()
    expect(demands(sent)).toEqual([{ watch: false, token: 'T1' }])
    hub.watch(viewer().v)
    expect(demands(sent)).toEqual([{ watch: false, token: 'T1' }, { watch: true, token: 'T1' }])
  })

  it('tells only the attached token', () => {
    const { hub, sent } = setup()
    hub.handleInvoke(COMPANION_ATTACH, { token: 'T1' })
    hub.handleInvoke(COMPANION_ATTACH, { token: 'T2' })
    hub.watch(viewer().v)
    expect(demands(sent)).toEqual([{ watch: true, token: 'T2' }])
  })
})

describe('the readiness handshake', () => {
  it('refuses a control before any editor attached, and sends the editor nothing', () => {
    const { hub, sent } = setup()
    expect(hub.control({ action: 'play' })).toBe('not_ready')
    expect(sent).toEqual([])
    hub.handleInvoke(COMPANION_ATTACH, { token: 'T1' })
    expect(hub.control({ action: 'seek', t_us: 1_500_000.4 })).toBe('ok')
    expect(sent).toEqual([[COMPANION_CONTROL_EVENT, { action: 'seek', t_us: 1_500_000, token: 'T1' }]])
  })

  it('keeps a newer attach when a stale token detaches', () => {
    const { hub } = setup()
    hub.handleInvoke(COMPANION_ATTACH, { token: 'T1' })
    hub.handleInvoke(COMPANION_ATTACH, { token: 'T2' })
    hub.handleInvoke(COMPANION_DETACH, { token: 'T1' })
    expect(hub.state().editor).toBe('ready')
    expect(hub.control({ action: 'play' })).toBe('ok')
    hub.handleInvoke(COMPANION_DETACH, { token: 'T2' })
    expect(hub.state().editor).toBe('opening')
    expect(hub.control({ action: 'play' })).toBe('not_ready')
  })

  it('drops the attach when the editor document goes, and stops the page playhead', () => {
    const { hub } = setup()
    hub.handleInvoke(COMPANION_ATTACH, { token: 'T1' })
    hub.handleInvoke(COMPANION_TRANSPORT, { token: 'T1', t_us: 2_000_000, playing: true })
    hub.editorGone()
    expect(hub.state()).toMatchObject({ editor: 'opening', transport: { t_us: 2_000_000, playing: false } })
    expect(hub.control({ action: 'pause' })).toBe('not_ready')
  })

  it('takes the transport from the attached token only', () => {
    const { hub } = setup()
    const { v, events } = viewer()
    hub.watch(v)
    hub.handleInvoke(COMPANION_ATTACH, { token: 'T2' })
    hub.handleInvoke(COMPANION_TRANSPORT, { token: 'T1', t_us: 9, playing: true })
    hub.handleInvoke(COMPANION_TRANSPORT, { token: 'T2', t_us: 5, playing: false })
    expect(hub.state().transport).toEqual({ t_us: 5, playing: false })
    expect(events.filter(([e]) => e === 'transport')).toEqual([['transport', { t_us: 5, playing: false }]])
  })

  it('tells watching pages when the editor comes and goes', () => {
    const { hub } = setup()
    const { v, events } = viewer()
    hub.watch(v)
    hub.attach('T1')
    hub.detach('T1')
    expect(events.filter(([e]) => e === 'editor')).toHaveLength(2)
  })

  it('brings the editor forward without an attached editor, and refuses a body that names no action', () => {
    const { hub, focused } = setup()
    expect(hub.control({ action: 'focus' })).toBe('ok')
    expect(focused()).toBe(1)
    expect(hub.control({ action: 'delete_layers' })).toBe('invalid')
    expect(hub.control({ action: 'seek' })).toBe('invalid')
    expect(hub.control(undefined)).toBe('invalid')
  })

  it('refuses a channel call without the bridge token', () => {
    const { hub } = setup()
    expect(() => hub.handleInvoke(COMPANION_ATTACH, {})).toThrow(/token/)
  })
})

describe('what the page hears from main', () => {
  it('relays project changes, export progress and the latest agent call', () => {
    const { hub } = setup()
    const { v, events } = viewer()
    hub.watch(v)
    hub.observe('project:changed', { publication: {} })
    hub.observe('export:status', { job_id: 'j', state: 'rendering', progress: 0.5, filename: 'cut.mp4' })
    hub.observe(AGENT_ACTIVITY_EVENT, { activities: [{ client: 'agent', tool: 'add_track', state: 'done' }, { client: 'agent', tool: 'add_layers', state: 'running' }] })
    hub.observe('previewGpu:frameReady', {})
    expect(events.map(([e]) => e)).toEqual(['project', 'export', 'activity'])
    expect(hub.state()).toMatchObject({
      export: { job_id: 'j', state: 'rendering', progress: 0.5, filename: 'cut.mp4' },
      activity: { client: 'agent', tool: 'add_layers', state: 'running' },
    })
  })
})
