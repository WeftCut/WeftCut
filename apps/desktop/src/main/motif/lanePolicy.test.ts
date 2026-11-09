import { describe, it, expect } from 'vitest'
import { LanePolicy } from './lanePolicy'
import { MotifError } from '../../shared/motifs/errors'

const timeout = () => new MotifError('timeout', 'motif capture timed out after 5000ms: Runtime.evaluate')

describe('LanePolicy', () => {
  it('a throw latches the lane as a content failure until the content hash changes', () => {
    const lanes = new LanePolicy()
    const err = lanes.threw('m', 'v1', new Error('detached'))
    expect(err).toMatchObject({ code: 'content', message: '[motif:content] detached' })
    expect(lanes.failure('m', 'v1')).toBe(err)
    expect(lanes.failure('m', 'v2')).toBeUndefined()
    expect(lanes.failure('other', 'v1')).toBeUndefined()
  })

  it('keeps a content error as it is', () => {
    const lanes = new LanePolicy()
    const content = new MotifError('content', '__motifRender threw: {}')
    expect(lanes.threw('m', 'v1', content)).toBe(content)
  })

  it('an ambiguous failure is probation; a second consecutive one latches the lane', () => {
    const lanes = new LanePolicy()
    const first = timeout()
    expect(lanes.ambiguous('m', 'v1', first)).toBe(first)
    expect(lanes.failure('m', 'v1')).toBeUndefined()
    expect(lanes.ambiguous('m', 'v1', timeout())).toMatchObject({ code: 'content', message: '[motif:content] motif capture timed out after 5000ms: Runtime.evaluate' })
    expect(lanes.failure('m', 'v1')).toMatchObject({ code: 'content' })
  })

  it('a render between two ambiguous failures ends the probation', () => {
    const lanes = new LanePolicy()
    lanes.ambiguous('m', 'v1', timeout())
    lanes.rendered('m', 'v1')
    const again = timeout()
    expect(lanes.ambiguous('m', 'v1', again)).toBe(again)
    expect(lanes.failure('m', 'v1')).toBeUndefined()
  })

  it('never marks a lane without a content hash', () => {
    const lanes = new LanePolicy()
    const thrown = new Error('boom')
    expect(lanes.threw('m', '', thrown)).toBe(thrown)
    lanes.ambiguous('m', '', timeout())
    const second = timeout()
    expect(lanes.ambiguous('m', '', second)).toBe(second)
    expect(lanes.failure('m', '')).toBeUndefined()
  })

  it('an explicit reset revokes only that lane', () => {
    const lanes = new LanePolicy()
    lanes.threw('a', 'v1', new Error('a'))
    lanes.threw('b', 'v1', new Error('b'))
    lanes.reset('a', 'v1')
    expect(lanes.failure('a', 'v1')).toBeUndefined()
    expect(lanes.failure('b', 'v1')).toBeDefined()
  })

  it('remembers at most 128 failed lanes, oldest out first', () => {
    const lanes = new LanePolicy()
    for (let i = 0; i <= 128; i++) lanes.threw('m', `v${i}`, new Error(String(i)))
    expect(lanes.failure('m', 'v0')).toBeUndefined()
    expect(lanes.failure('m', 'v1')).toBeDefined()
    expect(lanes.failure('m', 'v128')).toBeDefined()
  })
})
