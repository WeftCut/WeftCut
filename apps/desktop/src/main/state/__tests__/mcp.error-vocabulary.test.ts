// apps/desktop/src/main/state/__tests__/mcp.error-vocabulary.test.ts
// No refusal is a bare variant name. The audit found thirteen — `TrackLocked`,
// `LayerNotFound`, `UnknownKeyframeParam`, … — each a dead end: no id echoed,
// no next step, and for a multi-id call no way to tell which id failed. This
// gate enumerates every `CommandError` variant with representative fields and
// asserts the message is prose that names its ids, plus the three findings
// with a shape of their own: per-tool ripple remedies (D6), overlap options
// that would actually succeed (D5), and the two structured messages the
// descriptions promise (D24).
import { describe, it, expect } from 'vitest'
import { mapCommandError } from '../mcp-commands'
import type { CommandError } from '../errors'

const L1 = '00000000-0000-7000-8000-000000000001'
const L2 = '00000000-0000-7000-8000-000000000002'
const T1 = '00000000-0000-7000-8000-0000000000aa'
const X1 = '00000000-0000-7000-8000-0000000000ee'

/** One sample per variant of the union — a variant added to
 *  shared/commandErrors.ts without a row here is the only way past this gate,
 *  and the default arm names it as such. */
const EVERY_VARIANT: CommandError[] = [
  { error: 'TrackNotFound', track: T1 },
  { error: 'LayerNotFound', layer: L1 },
  { error: 'CompositionNotFound', composition: X1 },
  { error: 'CrossCompositionMove', layer: L1, from: X1, to: T1 },
  { error: 'CrossCompositionSet', layer: L1, composition: X1, expected: T1 },
  { error: 'WrongLayerKind', layer: L1, expected: 'Audio' },
  { error: 'MarkerNotFound', marker: X1 },
  { error: 'TransitionNotFound', transition: X1 },
  { error: 'TransitionLayersNotAdjacent', from: L1, to: L2, duration: 500_000 },
  { error: 'TransitionUnsupportedLayerKind', layer: L1, kind: 'Audio' },
  { error: 'TransitionInsufficientHandle', layer: L1, available_us: 100 },
  { error: 'TransitionRestoreCollision', layer: L1 },
  { error: 'TransitionParticipantsShareLink', from: L1, to: L2 },
  { error: 'CheckpointNotFound', checkpoint: X1 },
  { error: 'MediaNotFound', media: X1 },
  { error: 'MediaInUse', media: X1, referenced_by: [L1, L2] },
  { error: 'TrackPositionOutOfRange', position: 7, len: 3 },
  { error: 'TrackNotEmpty', track: T1 },
  { error: 'TrackNotRemovable', track: T1 },
  { error: 'TrackLocked', track: T1 },
  { error: 'RippleInsideHole', layer: L1, hole: { s: 0, e: 5 } },
  { error: 'RippleCollision', moving: L1, blocking: L2, track: T1 },
  { error: 'RippleLinkStraddles', link: X1, hole: { s: 0, e: 5 } },
  { error: 'RippleLockedLayer', layer: L1 },
  { error: 'GapNotFound', track: T1, s: 1, e: 2 },
  { error: 'SplitOutsideLayer', layer: L1, at_t: 9 },
  { error: 'LinkLockedMember', link: X1, locked_layer: L1, touched: L2 },
  { error: 'TrimEdgeOutOfRange', layer: L1, new_t: 0, cur_start: 0, cur_end: 9 },
  { error: 'LayerParamsKindMismatch', layer: L1, actual: 'Text', patch: 'Color' },
  { error: 'LinkNotFound', link: X1 },
  { error: 'LayerAlreadyLinked', layer: L1, existing: X1 },
  { error: 'LinkCreateNeedsTwoLayers', got: 1 },
  { error: 'LayerNotInLink', link: X1, layer: L1 },
  { error: 'GroupLockedMember', layer: L1 },
  { error: 'GroupNotPlain', layer: L1, reason: 'opacity' },
  { error: 'CompositionInUse', composition: X1, ref_count: 2 },
  { error: 'RootComposition', composition: X1 },
  { error: 'NothingToUndo' },
  { error: 'NothingToRedo' },
  { error: 'HistoryLocked', reason: 'batch in progress' },
  { error: 'ValidationFailed', detail: { rule: 'DuplicateLayerId', layer: L1 } },
  { error: 'ValidationFailed', detail: { rule: 'MissingMedia', layer: L1, media: X1 } },
  { error: 'EmptyKeyframeTrack', layer: L1, param_key: 'opacity' },
  { error: 'UnknownKeyframeParam', layer: L1, param_key: 'wobble' },
  { error: 'EffectNotFound', effect: X1 },
  { error: 'EffectIndexOutOfRange', index: 4, len: 2 },
  { error: 'EffectKindNotApplicable', kind: 'audio.denoise', layer_kind: 'Text' },
  { error: 'AudioEffectParamStatic', effect: X1, param: 'strength' },
  { error: 'FpsLockedByContent', current: { num: 30, den: 1 }, requested: { num: 25, den: 1 }, layer_count: 3, locked_by: 'current' },
  { error: 'InvalidArgument', field: 'pad_us', detail: 'must be >= 0' },
  { error: 'Backend', detail: 'ffprobe exited 1' },
]

const ID_FIELDS = ['track', 'layer', 'composition', 'marker', 'transition', 'checkpoint', 'media', 'link', 'effect', 'from', 'to', 'moving', 'blocking', 'locked_layer', 'touched', 'existing'] as const

describe('every CommandError variant maps to prose that names its ids', () => {
  for (const e of EVERY_VARIANT) {
    it(`${e.error}${'detail' in e ? ` / ${(e.detail as { rule: string }).rule}` : ''}`, () => {
      const out = mapCommandError(e)
      expect(out.message).not.toBe(e.error)
      // InvalidArgument and Backend carry the caller's own detail as the message
      // — as long as the detail; every other arm writes a sentence.
      if (e.error !== 'InvalidArgument' && e.error !== 'Backend') expect(out.message.length).toBeGreaterThan(e.error.length + 10)
      // Every id the variant carries appears in the text, so a multi-id call can
      // tell WHICH one failed.
      for (const f of ID_FIELDS) {
        const v = (e as Record<string, unknown>)[f]
        if (typeof v === 'string') expect(out.message, `${e.error}.${f}`).toContain(v)
      }
      if (e.error === 'ValidationFailed') {
        for (const [k, v] of Object.entries(e.detail)) if (k !== 'rule' && typeof v === 'string') expect(out.message).toContain(v)
      }
    })
  }

  it('an unknown variant (a union widened without a mapper arm) still names itself and its fields rather than throwing', () => {
    const out = mapCommandError({ error: 'FromTheFuture', widget: 'w-1' } as unknown as CommandError)
    expect(out.message).toContain('FromTheFuture')
    expect(out.message).toContain('widget w-1')
  })
})

describe('the ripple remedies are per tool (D6)', () => {
  const inside: CommandError = { error: 'RippleInsideHole', layer: L1, hole: { s: 0, e: 5_000_000 } }

  it('delete_layers is told to widen or narrow layer_ids', () => {
    const out = mapCommandError(inside, 'delete_layers')
    expect(out.message).toContain('add ' + L1 + ' to layer_ids')
    expect(out.message).toContain('without ripple')
  })

  it('ripple_delete_gap and remove_pauses have no layer_ids and are told to move or delete the blocker first', () => {
    for (const tool of ['ripple_delete_gap', 'remove_pauses']) {
      const out = mapCommandError(inside, tool)
      expect(out.message, tool).not.toContain('layer_ids')
      expect(out.message, tool).toContain(`move_layer or delete_layers ${L1} first`)
      expect((out.data as { tool: string }).tool).toBe(tool)
    }
    expect(mapCommandError(inside, 'remove_pauses').message).toContain('the pause cut')
    expect(mapCommandError(inside, 'ripple_delete_gap').message).toContain('closing the gap')
  })

  it('the other three ripple refusals drop the layer_ids clause for the tools that lack it', () => {
    const collision: CommandError = { error: 'RippleCollision', moving: L1, blocking: L2, track: T1 }
    expect(mapCommandError(collision, 'delete_layers').message).toContain('narrow layer_ids')
    expect(mapCommandError(collision, 'remove_pauses').message).not.toContain('layer_ids')
    const straddle: CommandError = { error: 'RippleLinkStraddles', link: X1, hole: { s: 0, e: 5 } }
    expect(mapCommandError(straddle, 'delete_layers').message).toContain('add the straddling members to layer_ids')
    expect(mapCommandError(straddle, 'ripple_delete_gap').message).not.toContain('layer_ids')
    const locked: CommandError = { error: 'RippleLockedLayer', layer: L1 }
    expect(mapCommandError(locked, 'delete_layers').message).toContain('narrow layer_ids')
    expect(mapCommandError(locked, 'remove_pauses').message).not.toContain('layer_ids')
  })
})

describe('LayerOverlap options are validated against the geometry (D5)', () => {
  const overlap = (a: [number, number], b: [number, number]): CommandError =>
    ({ error: 'ValidationFailed', detail: { rule: 'LayerOverlap', track: T1, a: L1, a_start: a[0], a_end: a[1], b: L2, b_start: b[0], b_end: b[1] } })
  const actions = (e: CommandError) => ((mapCommandError(e).data as { options: Array<{ action: string; edge?: string; new_t_us?: number; at_t_us?: number }> }).options)

  it('a request starting inside the blocker: trim its tail or split it there, plus the two that always work', () => {
    const opts = actions(overlap([0, 3_000_000], [2_000_000, 5_000_000]))
    expect(opts.map((o) => o.action)).toEqual(['create_new_track', 'move_layer', 'trim_existing', 'split_at_t'])
    expect(opts[2]).toMatchObject({ edge: 'out', new_t_us: 2_000_000 })
    expect(opts[3]).toMatchObject({ at_t_us: 2_000_000 })
  })

  it('a request starting at or before the blocker (the audit\'s split_at_t 0 case): never a split at the start, never a trim to the start', () => {
    // The audit followed `split_at_t 0` / `trim_existing to 0` and got
    // SplitOutsideLayer and a one-frame clip. Here the request covers the
    // blocker's head, so the blocker's START is what moves.
    const opts = actions(overlap([0, 3_000_000], [0, 1_000_000]))
    expect(opts.map((o) => o.action)).toEqual(['create_new_track', 'move_layer', 'trim_existing'])
    expect(opts[2]).toMatchObject({ edge: 'in', new_t_us: 1_000_000 })
    const msg = mapCommandError(overlap([0, 3_000_000], [0, 1_000_000])).message
    expect(msg).not.toContain('split_layer')
    expect(msg).toContain("trim_layer " + L1 + " edge 'in' to 1000000")
  })

  it('a request that swallows the blocker whole offers only the two that always work', () => {
    const opts = actions(overlap([1_000_000, 2_000_000], [0, 3_000_000]))
    expect(opts.map((o) => o.action)).toEqual(['create_new_track', 'move_layer'])
  })
})

describe('the messages the descriptions promise (D24)', () => {
  it('HistoryLocked carries the reason and the way out', () => {
    const out = mapCommandError({ error: 'HistoryLocked', reason: 'rough cut in progress' })
    expect(out.message).toContain('rough cut in progress')
    expect(out.message).toContain('set_history_lock { locked: false }')
    expect(out.data).toMatchObject({ reason: 'rough cut in progress' })
  })

  it('FpsLockedByContent carries current, requested, layer_count and locked_by, and says which scope blocked', () => {
    const current = mapCommandError({ error: 'FpsLockedByContent', current: { num: 30, den: 1 }, requested: { num: 25, den: 1 }, layer_count: 3, locked_by: 'current' })
    expect(current.message).toContain('30/1')
    expect(current.message).toContain('25/1')
    expect(current.message).toContain('3 layer(s)')
    expect(current.data).toEqual({ error: 'FpsLockedByContent', current: { num: 30, den: 1 }, requested: { num: 25, den: 1 }, layer_count: 3, locked_by: 'current' })
    const history = mapCommandError({ error: 'FpsLockedByContent', current: { num: 30, den: 1 }, requested: { num: 25, den: 1 }, layer_count: 0, locked_by: 'history' })
    expect(history.message).toContain('history snapshot or checkpoint')
    expect(history.message).not.toContain('0 layer(s)')
  })

  it('TrackLocked and MediaInUse name the fix, not the fact', () => {
    expect(mapCommandError({ error: 'TrackLocked', track: T1 }).message).toContain(`set_track_flags { track_id: "${T1}", locked: false }`)
    const inUse = mapCommandError({ error: 'MediaInUse', media: X1, referenced_by: [L1, L2] })
    expect(inUse.message).toContain('2 layer(s)')
    expect(inUse.message).toContain('force: true')
  })
})
