import { describe, expect, it } from 'vitest'
import { createActor, type ActorHandle } from './actor'
import { seededGen } from './ids'
import { blankProject, rootComposition } from './model'

const agent = { kind: 'Agent' as const, client: 'review-test' }
const MEDIA = '00000000-0000-0000-0000-0000000000cc'
function setup() {
  const ids = seededGen()
  const actor = createActor({ initial: blankProject(ids, 'Project fields review'), idGen: ids })
  const run = (name: Parameters<ActorHandle['dispatch']>[0], args: Record<string, unknown>, by = agent) => {
    const r = actor.dispatch(name, args, by)
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    return r.value
  }
  return { actor, run }
}

describe('review outside compositions', () => {
  it('reviews role gain with default 0 dB, reverts it, and restores the diff on undo', () => {
    const { actor, run } = setup()
    actor.pinReviewBaseline()
    run('set_role_gain', { role: 'music', gain_db: -24 })
    const change = { id: 'AudioRole:music', class: 'modified', composition_id: null, ranges: [], details: [{ type: 'gain', from_db: 0, to_db: -24 }] }
    expect(actor.reviewState().unreviewed).toEqual([change])
    const op = actor.historyView(1).ops[0]!.op_id
    expect(actor.reviewOpDiff([op]).changes).toEqual([change])
    actor.revertReviewAll()
    expect(actor.snapshot().audio_roles.music?.gain_db ?? 0).toBe(0)
    run('undo', {})
    expect(actor.reviewState().unreviewed).toEqual([change])
    actor.approveReviewAll()
    expect(actor.reviewState().unreviewed).toEqual([])
  })

  it('does not turn default materialization or preference flags into a gain change', () => {
    const { actor, run } = setup()
    actor.pinReviewBaseline()
    run('set_role_gain', { role: 'music', gain_db: 0 })
    run('update_role_flags', { role: 'music', patch: { muted: true, solo: true } })
    expect(actor.reviewState().unreviewed).toEqual([])
    expect(actor.reviewState().user).toEqual([])
  })

  it('reports force-removed pool media as well as clips and retains their baseline names', () => {
    const { actor, run } = setup()
    run('add_media', { id: MEDIA, kind: 'Video', duration_us: 2_000_000, with_audio: false })
    const track = rootComposition(actor.snapshot()).tracks[0]!.id
    const clip = run('add_layer', { track, kind: 'video', media: MEDIA, src_in_us: 0, src_out_us: 2_000_000, t_start_us: 0, t_end_us: 2_000_000 })
    actor.approveReviewAll()
    run('remove_media', { media: MEDIA, force: true })
    expect(actor.reviewState().unreviewed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `Media:${MEDIA}`, class: 'removed', composition_id: null, before_name: expect.any(String) }),
      expect.objectContaining({ id: `Layer:${clip}`, class: 'removed', before_name: expect.any(String) }),
    ]))
    actor.revertReviewAll()
    expect(actor.snapshot().media_pool[MEDIA]).toBeDefined()
    expect(actor.reviewState().unreviewed).toEqual([])
  })

  it('keeps imports, unused-media removal and project settings outside recorded review', () => {
    const { actor, run } = setup()
    actor.pinReviewBaseline()
    run('add_media', { id: MEDIA, kind: 'Video', duration_us: 2_000_000, with_audio: false })
    expect(actor.reviewState().unreviewed).toEqual([])
    run('remove_media', { media: MEDIA, force: false })
    run('update_project_settings', { patch: { prefer_proxies: true } })
    expect(actor.reviewState().unreviewed).toEqual([])
    expect(actor.reviewState().user).toEqual([])
  })
})
