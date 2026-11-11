// apps/desktop/src/main/state/history.entity-labels.test.ts
//
// `History` keeps each row's entity labels and resolves them again only when
// their inputs change (`labelsAt`). These tests hold the kept labels to a
// resolve from scratch, and count resolves to show a view after one commit
// resolves the new row only.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { seededGen } from './ids'
import { blankProject, type Layer, type MediaItem, type Project } from './model'
import { colorParams } from './mutations/add'
import { History, type Actor, type EntityRef, type HistoryView } from './history'
import * as labels from './history-labels'
import { root, withRoot } from './__tests__/fixtures/project'
import { PBT_RUNS, PBT_SEED } from './__tests__/pbt/harness'

vi.mock('./history-labels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./history-labels')>()
  return { ...actual, resolveEntityLabels: vi.fn(actual.resolveEntityLabels) }
})
const { resolveEntityLabels: resolveFresh } = await vi.importActual<typeof import('./history-labels')>('./history-labels')
const resolveSpy = vi.mocked(labels.resolveEntityLabels)

const USER: Actor = { kind: 'User' }
const AGENT: Actor = { kind: 'Agent', client: 'test' }
const KEY = labels.HISTORY_SUMMARY.layerUpdate.key
const MEDIA = 'M0'
const LAYER_IDS = ['L0', 'L1', 'L2', 'L3']

/** A layer named by its own label, else (for the media-backed ones) by its
 *  media's label, else by its kind — so relabelling the media changes the row. */
function layer(id: string, label: string | null): Layer {
  const mediaBacked = id === 'L0' || id === 'L2'
  return {
    id, label, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {}, effects: [],
    params: mediaBacked
      ? ({ kind: 'Audio', media: MEDIA } as unknown as Layer['params'])
      : colorParams({ r: 0, g: 0, b: 0, a: 255 }, 1920, 1080),
  }
}
function media(label: string | null): MediaItem {
  return { id: MEDIA, label, path_abs: '/home/u/media/take.wav' } as unknown as MediaItem
}
function withLayers(p: Project, edit: (layers: Layer[]) => Layer[]): Project {
  return withRoot(p, { tracks: root(p).tracks.map((t, i) => (i === 0 ? { ...t, layers: edit(t.layers) } : t)) })
}
function freshProject(): Project {
  const p = blankProject(seededGen(), 'labels')
  return { ...p, media_pool: { [MEDIA]: media('Take') } }
}

/** `h.view(limit)` with every row's labels resolved from scratch. The stored
 *  snapshots are read back through `jumpTo`, the cursor then put back. */
function viewFromScratch(h: History, limit: number): HistoryView {
  const v = h.view(limit)
  const cursor = h.cursorIndex()
  const snapshots = Array.from({ length: h.len() }, (_, i) => h.jumpTo(i)!)
  h.jumpTo(cursor)
  return {
    ...v,
    ops: v.ops.map((op, i) => {
      const index = v.window_start + i
      return { ...op, entity_labels: resolveFresh(snapshots[index], snapshots[index - 1] ?? null, op.affected) }
    }),
  }
}

// ── the operation model ──

type Edit =
  | { kind: 'put'; layer: number; label: string | null }
  | { kind: 'delete'; layer: number }
  | { kind: 'renameTrack'; label: string | null }
  | { kind: 'touch'; layer: number } // records the same snapshot again

type Step =
  | { kind: 'commit'; edits: Edit[]; agent: boolean }
  | { kind: 'undo' } | { kind: 'redo' } | { kind: 'jump'; at: number }
  | { kind: 'checkpoint' } | { kind: 'restore'; which: number } | { kind: 'deleteCheckpoint'; which: number }
  | { kind: 'pinReview' } | { kind: 'approve' } | { kind: 'revert' }
  | { kind: 'settings'; width: number }
  | { kind: 'trackFlags'; muted: boolean }
  | { kind: 'roleFlags'; solo: boolean }
  | { kind: 'mediaPool'; label: string | null }
  | { kind: 'relabelEverywhere'; layer: number; label: string }
  | { kind: 'reset' }

const label = fc.constantFrom<string | null>(null, '', '  ', 'Intro', 'Outro')
const layerIndex = fc.integer({ min: 0, max: LAYER_IDS.length - 1 })
const edit: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({ kind: fc.constant('put' as const), layer: layerIndex, label }),
  fc.record({ kind: fc.constant('delete' as const), layer: layerIndex }),
  fc.record({ kind: fc.constant('renameTrack' as const), label }),
  fc.record({ kind: fc.constant('touch' as const), layer: layerIndex }),
)
const step: fc.Arbitrary<Step> = fc.oneof(
  // Bursts long enough that a few of them push the stack past its cap.
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('commit' as const), edits: fc.array(edit, { minLength: 1, maxLength: 90 }), agent: fc.boolean() }) },
  { weight: 2, arbitrary: fc.constantFrom<Step>({ kind: 'undo' }, { kind: 'redo' }) },
  fc.record({ kind: fc.constant('jump' as const), at: fc.double({ min: 0, max: 1, noNaN: true }) }),
  fc.constant<Step>({ kind: 'checkpoint' }),
  fc.record({ kind: fc.constant('restore' as const), which: fc.nat() }),
  fc.record({ kind: fc.constant('deleteCheckpoint' as const), which: fc.nat() }),
  fc.constantFrom<Step>({ kind: 'pinReview' }, { kind: 'approve' }, { kind: 'revert' }),
  fc.record({ kind: fc.constant('settings' as const), width: fc.integer({ min: 320, max: 1920 }) }),
  fc.record({ kind: fc.constant('trackFlags' as const), muted: fc.boolean() }),
  fc.record({ kind: fc.constant('roleFlags' as const), solo: fc.boolean() }),
  fc.record({ kind: fc.constant('mediaPool' as const), label }),
  fc.record({ kind: fc.constant('relabelEverywhere' as const), layer: layerIndex, label: fc.constantFrom('Renamed', 'Again') }),
  fc.constant<Step>({ kind: 'reset' }),
)

function apply(h: History, s: Step, gen: () => string): void {
  switch (s.kind) {
    case 'commit':
      for (const e of s.edits) {
        const p = h.current()
        let next: Project = p
        let affected: EntityRef[]
        if (e.kind === 'put') {
          const id = LAYER_IDS[e.layer]
          next = withLayers(p, (ls) => [...ls.filter((l) => l.id !== id), layer(id, e.label)])
          affected = [{ kind: 'Layer', id }]
        } else if (e.kind === 'delete') {
          const id = LAYER_IDS[e.layer]
          next = withLayers(p, (ls) => ls.filter((l) => l.id !== id))
          affected = [{ kind: 'Layer', id }, { kind: 'Layer', id: 'ghost' }]
        } else if (e.kind === 'renameTrack') {
          next = withRoot(p, { tracks: root(p).tracks.map((t, i) => (i === 1 ? { ...t, label: e.label } : t)) })
          affected = [{ kind: 'Track', id: root(p).tracks[1].id }]
        } else {
          affected = [{ kind: 'Layer', id: LAYER_IDS[e.layer] }]
        }
        h.record({ op_id: gen(), actor: s.agent ? AGENT : USER, timestamp: '<TS>', summary: 'edit', label_key: KEY, affected, snapshot: next })
      }
      return
    case 'undo': h.undo(); return
    case 'redo': h.redo(); return
    case 'jump': h.jumpTo(Math.min(h.len() - 1, Math.floor(s.at * h.len()))); return
    case 'checkpoint': h.checkpoint('cp', USER, gen()); return
    case 'restore': {
      const cps = h.listCheckpoints()
      if (cps.length > 0) h.restoreCheckpoint(cps[s.which % cps.length].id, gen(), '<TS>', USER)
      return
    }
    case 'deleteCheckpoint': {
      const cps = h.listCheckpoints()
      if (cps.length > 0) h.deleteCheckpoint(cps[s.which % cps.length].id)
      return
    }
    case 'pinReview': h.pinReviewBaseline(); return
    case 'approve': h.approveAll(); return
    case 'revert': h.revertToReviewBaseline(gen(), '<TS>', USER); return
    case 'settings': h.replaceSettingsEverywhere({ ...h.current().settings, preview_width: s.width }); return
    case 'trackFlags': h.replaceTrackFlagsEverywhere(root(h.current()).tracks[0].id, { muted: s.muted }); return
    case 'roleFlags': h.replaceRoleFlagsEverywhere('Dialogue', { solo: s.solo }); return
    case 'mediaPool': h.replaceMediaPoolEverywhere({ [MEDIA]: media(s.label) }); return
    case 'relabelEverywhere': {
      const id = LAYER_IDS[s.layer]
      h.replaceCompositionEverywhere((p) => root(p).tracks[0].layers.some((l) => l.id === id)
        ? withLayers(p, (ls) => ls.map((l) => (l.id === id ? { ...l, label: s.label } : l)))
        : p)
      return
    }
    case 'reset': h.reset(freshProject(), USER, gen()); return
  }
}

describe('History entity labels are kept per row', () => {
  beforeEach(() => { resolveSpy.mockClear() })

  it('every view equals one resolved from scratch, across every way the stack changes', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 12 }), (steps) => {
        const gen = seededGen()
        const h = new History(freshProject(), USER, gen())
        for (const s of steps) {
          apply(h, s, gen)
          for (const limit of [1, 100, h.capacity()]) expect(h.view(limit)).toEqual(viewFromScratch(h, limit))
        }
      }),
      { seed: PBT_SEED, numRuns: Math.min(PBT_RUNS, 60) },
    )
  })

  function committer(h: History, gen: () => string): (n: number) => void {
    return (n) => {
      const id = LAYER_IDS[n % LAYER_IDS.length]
      h.record({ op_id: gen(), actor: USER, timestamp: '<TS>', summary: 'edit', label_key: KEY,
        affected: [{ kind: 'Layer', id }], snapshot: withLayers(h.current(), (ls) => [...ls.filter((l) => l.id !== id), layer(id, `n${n}`)]) })
    }
  }
  const K = 7

  it('a view after one commit resolves the new row only', () => {
    const gen = seededGen()
    const h = new History(freshProject(), USER, gen())
    const commit = committer(h, gen)
    for (let n = 0; n < 40; n++) commit(n)
    resolveSpy.mockClear()

    const rows = h.view(h.capacity()).ops.length
    for (let k = 0; k < K; k++) {
      commit(1000 + k)
      h.view(h.capacity())
    }
    expect(resolveSpy).toHaveBeenCalledTimes(rows + K)
  })

  // At the cap a commit also evicts, and the row that becomes first loses its
  // predecessor — one of its inputs — so it is resolved again too.
  it('a view after one commit on a full stack resolves the new row and the new first row', () => {
    const gen = seededGen()
    const h = new History(freshProject(), USER, gen())
    const commit = committer(h, gen)
    for (let n = 0; n < h.capacity() + 5; n++) commit(n)
    resolveSpy.mockClear()

    const rows = h.view(h.capacity()).ops.length
    for (let k = 0; k < K; k++) {
      commit(1000 + k)
      h.view(h.capacity())
    }
    expect(resolveSpy).toHaveBeenCalledTimes(rows + 2 * K)
  })

  it('an *Everywhere patch resolves every row again, and the names follow it', () => {
    const gen = seededGen()
    const h = new History(freshProject(), USER, gen())
    h.record({ op_id: gen(), actor: USER, timestamp: '<TS>', summary: 'edit', label_key: KEY,
      affected: [{ kind: 'Layer', id: 'L0' }], snapshot: withLayers(h.current(), () => [layer('L0', null)]) })
    expect(h.view(10).ops[1].entity_labels).toEqual([{ text: 'Take' }])

    h.replaceMediaPoolEverywhere({ [MEDIA]: media('Retake') })
    expect(h.view(10).ops[1].entity_labels).toEqual([{ text: 'Retake' }])
  })

  // The first stored row is named without a predecessor once eviction has run,
  // so a delete there loses the name its predecessor gave it.
  it('re-resolves the first row when eviction takes its predecessor away', () => {
    const gen = seededGen()
    const named = withLayers(freshProject(), () => [layer('L1', 'Clip 01')])
    const h = new History(named, USER, gen())
    const deleted = withLayers(named, () => [])
    h.record({ op_id: gen(), actor: USER, timestamp: '<TS>', summary: 'delete', label_key: KEY,
      affected: [{ kind: 'Layer', id: 'L1' }], snapshot: deleted })
    for (let n = 0; n < h.capacity() - 2; n++) h.record({ op_id: gen(), actor: USER, timestamp: '<TS>', summary: 'noop', label_key: KEY, affected: [], snapshot: deleted })
    expect(h.view(h.capacity()).ops[1].entity_labels).toEqual([{ text: 'Clip 01' }])

    h.record({ op_id: gen(), actor: USER, timestamp: '<TS>', summary: 'noop', label_key: KEY, affected: [], snapshot: deleted })
    const v = h.view(h.capacity())
    expect(v.evicted).toBe(1)
    expect(v.ops[0].summary).toBe('delete')
    expect(v.ops[0].entity_labels).toEqual([{ text: 'L1' }])
  })
})
