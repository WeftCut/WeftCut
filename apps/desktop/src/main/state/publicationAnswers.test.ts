import { describe, expect, it } from 'vitest'
import { createPublicationAnswers } from './publicationAnswers'
import { applySnapshotPatches } from '../../shared/snapshotPatch'

type View = { n: number }
const version = (revision: number, session = 1) => ({ session, revision })
const view = (revision: number, summary: View | null = { n: revision }, session = 1) => ({ version: version(revision, session), summary })
const start = () => {
  const answer = createPublicationAnswers<View>()
  const first = answer(view(1), null)
  return { answer, first: first.viewId }
}

describe('publication answers', () => {
  it('a reader naming no base receives the whole projection', () => {
    const { answer } = start()
    expect(answer(view(2), null)).toEqual({ ...view(2), viewId: 2 })
  })

  it('a reader naming a remembered answer receives the difference from it', () => {
    const { answer, first } = start()
    expect(answer(view(2), first)).toEqual({ version: version(2), viewId: 2, base: first, patches: [{ path: ['n'], value: 2 }] })
  })

  it('a reader a few answers behind still receives a difference; one too far behind does not', () => {
    const { answer, first } = start()
    for (let r = 2; r <= 8; r++) answer(view(r), null)
    expect(answer(view(9), first)).toHaveProperty('patches')
    expect(answer(view(10), first)).toHaveProperty('summary')
  })

  it('never answers across a session, or for a closed workspace', () => {
    const { answer, first } = start()
    expect(answer(view(2, { n: 2 }, 2), first)).toHaveProperty('summary')
    const closed = answer(view(3, null, 2), 2)
    expect(closed).toMatchObject({ summary: null })
    expect(answer(view(4, { n: 4 }, 2), closed.viewId)).toHaveProperty('summary')
  })

  it('a base from nowhere receives the whole projection', () => {
    const { answer } = start()
    expect(answer(view(2), 999)).toHaveProperty('summary')
  })

  it('a reader that dropped a forced refresh still receives what moved since the answer it holds', () => {
    const { answer, first } = start()
    answer({ version: version(1), summary: { n: 50 } }, first) // dropped by the reader
    const reply = answer({ version: version(1), summary: { n: 99 } }, first)
    expect(reply).toMatchObject({ base: first, patches: [{ path: ['n'], value: 99 }] })
    expect(answer({ version: version(1), summary: { n: 1 } }, first)).toMatchObject({ patches: [] })
  })

  it('a difference larger than the projection is worth is not sent', () => {
    const answer = createPublicationAnswers<{ list: number[] }>()
    const list = (n: number) => Array.from({ length: 3000 }, (_, i) => i + n)
    const first = answer({ version: version(1), summary: { list: list(0) } }, null)
    const next = { version: version(2), summary: { list: list(1) } }
    const second = answer(next, first.viewId)
    expect(second).toEqual({ ...next, viewId: second.viewId })
    const small = { version: version(3), summary: { list: list(1).with(0, -1) } }
    const reply = answer(small, second.viewId)
    if (!('patches' in reply)) throw new Error('expected a difference')
    expect(applySnapshotPatches(next.summary, reply.patches)).toEqual(small.summary)
  })
})
