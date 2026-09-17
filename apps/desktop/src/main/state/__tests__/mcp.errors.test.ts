// apps/desktop/src/main/state/__tests__/mcp.errors.test.ts
//
// `mapCommandError`'s STRUCTURED arms. A CommandError reaching an agent as bare
// prose is a dead end — it has to re-derive the fix or give up — so the arms that
// carry machine-usable `data` are the ones worth pinning. The grid + bounds rules
// are the strongest case: their fix is a single corrected number that the actor
// already computed, so the retry is mechanical.
import { describe, it, expect } from 'vitest'
import { mapCommandError, dryRunErrorString } from '../mcp-commands'
import type { CommandError } from '../errors'

const validationFailed = (detail: Extract<CommandError, { error: 'ValidationFailed' }>['detail']): CommandError =>
  ({ error: 'ValidationFailed', detail })

describe('mapCommandError — grid and bounds rules are self-correcting', () => {
  it('echoes snap_to for an off-grid layer boundary on the composition frame grid', () => {
    const out = mapCommandError(validationFailed({
      rule: 'OffGridLayerBoundary', layer: 'L1', field: 't_end_us',
      t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame', snap_to: 3_000_000,
    }))
    expect(out.code).toBe('invalid_params')
    expect(out.data).toEqual({
      error: 'OffGridLayerBoundary', layer: 'L1', field: 't_end_us',
      requested_us: 2_999_999, snap_to_us: 3_000_000, grid: 'frame', rate: [30, 1],
      options: [{ action: 'retry_snapped', field: 't_end_us', t_us: 3_000_000 }],
    })
    expect(out.message).toContain('3000000')
  })

  it('names the AUDIO lattice rather than reporting 48000/1 as a frame rate', () => {
    // Without this the message reads as an absurd 48 000 fps composition, which is
    // the one way a caller could misread the two-lattice model (spec R2-D6).
    const out = mapCommandError(validationFailed({
      rule: 'OffGridLayerBoundary', layer: 'A1', field: 't_start_us',
      t: 33_367, fps: { num: 48_000, den: 1 }, grid: 'sample', snap_to: 33_375,
    }))
    expect(out.message).toContain('48000 Hz audio sample lattice')
    expect(out.message).not.toContain('fps')
    expect((out.data as { grid: string }).grid).toBe('sample')
    expect((out.data as { snap_to_us: number }).snap_to_us).toBe(33_375)
  })

  it('echoes snap_to for an off-grid composition duration and marker time', () => {
    const comp = mapCommandError(validationFailed({
      rule: 'OffGridTime', entity: 'Composition', id: null, field: 'duration_us',
      t: 2_999_999, fps: { num: 30, den: 1 }, snap_to: 3_000_000,
    }))
    expect(comp.data).toMatchObject({ error: 'OffGridTime', entity: 'Composition', id: null, snap_to_us: 3_000_000 })
    const marker = mapCommandError(validationFailed({
      rule: 'OffGridTime', entity: 'Marker', id: 'MK', field: 't_us',
      t: 2_999_999, fps: { num: 30, den: 1 }, snap_to: 3_000_000,
    }))
    expect(marker.data).toMatchObject({ error: 'OffGridTime', entity: 'Marker', id: 'MK', snap_to_us: 3_000_000 })
  })

  it('tells a caller that timeline time starts at zero', () => {
    const out = mapCommandError(validationFailed({ rule: 'NegativeLayerStart', layer: 'L1', t_start: -5_000_000 }))
    expect(out.data).toEqual({
      error: 'NegativeLayerStart', layer: 'L1', requested_us: -5_000_000,
      options: [{ action: 'retry_clamped', t_start_us: 0 }],
    })
  })

  it('names the rule and its fields for every other validation rule', () => {
    // The enrichment with `options` is opt-in per rule; the rest still say WHICH
    // rule and WHICH entity, never the bare 'ValidationFailed'.
    const out = mapCommandError(validationFailed({ rule: 'DuplicateLayerId', layer: 'L1' }))
    expect(out.code).toBe('invalid_params')
    expect(out.message).toContain('DuplicateLayerId')
    expect(out.message).toContain('layer L1')
    expect(out.data).toEqual({ error: 'ValidationFailed', rule: 'DuplicateLayerId', layer: 'L1' })
  })
})

describe('mapCommandError — ripple delete names the span and the way out', () => {
  // The four refusals differ only in WHICH entity blocked, and each has a
  // different remedy, so a bare variant name is useless to an agent. What must
  // survive: the entity id, the half-open span in µs (the hole is the layer's
  // clipped footprint, not its length), and the next call.
  const HOLE = { s: 2_000_000, e: 5_000_000 }

  it('offers both ways past a layer starting inside the span', () => {
    const out = mapCommandError({ error: 'RippleInsideHole', layer: 'L1', hole: HOLE })
    expect(out.code).toBe('invalid_params')
    expect(out.message).toContain('[2000000, 5000000) µs')
    expect(out.data).toMatchObject({
      error: 'RippleInsideHole', layer: 'L1', hole_us: [2_000_000, 5_000_000],
      options: [
        { action: 'add_to_set_then_retry', layer_ids: ['L1'] },
        { action: 'delete_without_ripple', tool: 'delete_layers', ripple: false },
      ],
    })
  })

  it('names both layers and the track of a landing collision', () => {
    const out = mapCommandError({ error: 'RippleCollision', moving: 'M1', blocking: 'B1', track: 'T1' })
    // "never makes room" is the TransitionRestoreCollision precedent restated:
    // without it an agent retries the identical call expecting a shove.
    expect(out.message).toContain('never makes room')
    for (const id of ['M1', 'B1', 'T1']) expect(out.message).toContain(id)
    expect(out.data).toEqual({ error: 'RippleCollision', moving: 'M1', blocking: 'B1', track: 'T1', tool: null })
  })

  it('points a straddling link at the unlink retry', () => {
    const out = mapCommandError({ error: 'RippleLinkStraddles', link: 'K1', hole: HOLE })
    expect(out.message).toContain('[2000000, 5000000) µs')
    expect(out.data).toEqual({
      error: 'RippleLinkStraddles', link: 'K1', hole_us: [2_000_000, 5_000_000], tool: null,
      options: [{ action: 'unlink_then_retry', link_id: 'K1' }],
    })
  })

  it('says the lock reading is lenient so an upstream lock is not chased', () => {
    const out = mapCommandError({ error: 'RippleLockedLayer', layer: 'L9' })
    expect(out.message).toContain('L9')
    expect(out.message).toContain('locked: false')
    expect(out.message).toMatch(/upstream of the cut is fine/)
    expect(out.data).toEqual({ error: 'RippleLockedLayer', layer: 'L9', tool: null })
  })

  // The gap closing (ADR 0069): the fix is always "re-read the lane and send
  // the gap as it is now", so the message says what a gap IS and the data
  // echoes the span that was sent.
  it('echoes the span that was not a gap and points at the composition resource', () => {
    const out = mapCommandError({ error: 'GapNotFound', track: 'T1', s: 2_000_000, e: 3_000_000 })
    expect(out.code).toBe('invalid_params')
    expect(out.message).toContain('[2000000, 3000000) µs')
    expect(out.message).toContain('T1')
    expect(out.message).toMatch(/after the last layer .* is not a gap/)
    expect(out.data).toEqual({
      error: 'GapNotFound', track: 'T1', span_us: [2_000_000, 3_000_000],
      options: [{ action: 'reread_then_retry', resource: 'project://compositions' }],
    })
  })
})

describe('dryRunErrorString', () => {
  it('carries the corrected value into dry-run prose', () => {
    // A dry run is exactly where an agent is still able to fix the op cheaply.
    expect(dryRunErrorString(validationFailed({
      rule: 'OffGridLayerBoundary', layer: 'L1', field: 't_end_us',
      t: 2_999_999, fps: { num: 30, den: 1 }, grid: 'frame', snap_to: 3_000_000,
    }))).toBe('validation failed: OffGridLayerBoundary (t_end_us 2999999 µs → send 3000000)')
  })

  it('falls back to the rule name for everything else', () => {
    expect(dryRunErrorString(validationFailed({ rule: 'DuplicateLayerId', layer: 'L1' })))
      .toBe('validation failed: DuplicateLayerId')
  })

  it('reads as prose for the ripple refusals rather than the bare variant name', () => {
    // These reach an agent mid-plan, where the whole point is to fix the op
    // before spending a wet call — the generic `return e.error` would print
    // 'RippleInsideHole' and name nothing.
    expect(dryRunErrorString({ error: 'RippleInsideHole', layer: 'L1', hole: { s: 2_000_000, e: 5_000_000 } }))
      .toBe('layer L1 starts inside the span [2000000, 5000000) µs the ripple would close — add it to layer_ids, or delete without rippling')
    expect(dryRunErrorString({ error: 'RippleCollision', moving: 'M1', blocking: 'B1', track: 'T1' }))
      .toBe('layer M1 would ripple left onto layer B1 on track T1')
    expect(dryRunErrorString({ error: 'RippleLinkStraddles', link: 'K1', hole: { s: 0, e: 1_000_000 } }))
      .toBe('link K1 has members on both sides of the span [0, 1000000) µs the ripple would close')
    expect(dryRunErrorString({ error: 'RippleLockedLayer', layer: 'L9' }))
      .toBe('layer L9 is locked and would have to move')
    expect(dryRunErrorString({ error: 'GapNotFound', track: 'T1', s: 2_000_000, e: 3_000_000 }))
      .toBe('[2000000, 3000000) µs is not a gap on track T1')
  })
})
