// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import en from '../i18n/locales/en-US'
import zh from '../i18n/locales/zh-CN'
import type { Change, ChangeDetail } from '../../shared/review'
import { ROOT_ID, compositionFixture, summaryFixture } from '../testing/summaryFixture'
import type { TrackSummary } from '../ipc'
import { DETAIL_KEYS, changeWordsContext, describeChange, paramName, statesPlace, type Translate } from './changeWords'

const S = 1_000_000
const track = (id: string, label: string | null): TrackSummary => ({ id, kind: 'Video', label, enabled: true, locked: false, muted: false, solo: false, role: null, transient: false, layers: [] })
const summary = summaryFixture({
  root: { tracks: [track('t1', null), track('t2', null)] },
  groups: [compositionFixture({ id: 'grp', label: 'Intro', tracks: [] })],
})
const change = (details: ChangeDetail[], patch: Partial<Change> = {}): Change => ({
  id: 'Layer:x', class: 'modified', details,
  composition_id: ROOT_ID, ranges: [], ...patch,
})

let tEn: Translate, tZh: Translate
beforeAll(() => {
  tEn = i18n.getFixedT('en-US') as unknown as Translate
  tZh = i18n.getFixedT('zh-CN') as unknown as Translate
})
const say = (t: Translate, details: ChangeDetail[], patch?: Partial<Change>) =>
  describeChange(change(details, patch), changeWordsContext(t, summary, new Map([['grp', 1]])))

describe('describeChange', () => {
  it('does not hide a microsecond difference or drop a time value sign', () => {
    expect(say(tEn, [{ type: 'time', field: 'start', from_us: -1, to_us: 1 }])).toBe('Start -0.000001 → 0.000001 s')
  })
  it.each<[string, ChangeDetail[], Partial<Change>, string, string]>([
    ['removed length', [{ type: 'length', duration_us: 4 * S }], { class: 'removed' }, '删除 4.0 秒', 'Deleted 4.0 s'],
    ['added length', [{ type: 'length', duration_us: 3 * S }], { class: 'added' }, '时长 3.0 秒', '3.0 s long'],
    ['trim head', [{ type: 'trim', side: 'start', delta_us: -S }], {}, '开头剪掉 1.0 秒', 'Cut 1.0 s from the start'],
    ['trim tail', [{ type: 'trim', side: 'end', delta_us: -S }], {}, '结尾剪掉 1.0 秒', 'Cut 1.0 s from the end'],
    ['extend head', [{ type: 'trim', side: 'start', delta_us: S }], {}, '开头延长 1.0 秒', 'Extended start by 1.0 s'],
    ['extend tail', [{ type: 'trim', side: 'end', delta_us: S }], {}, '结尾延长 1.0 秒', 'Extended end by 1.0 s'],
    ['start', [{ type: 'time', field: 'start', from_us: 2 * S, to_us: S }], {}, '起点 2.0 → 1.0 秒', 'Start 2.0 → 1.0 s'],
    ['end', [{ type: 'time', field: 'end', from_us: 3 * S, to_us: 4 * S }], {}, '终点 3.0 → 4.0 秒', 'End 3.0 → 4.0 s'],
    ['source start', [{ type: 'time', field: 'source_start', from_us: 0, to_us: S }], {}, '素材起点 0.0 → 1.0 秒', 'Source start 0.0 → 1.0 s'],
    ['source end', [{ type: 'time', field: 'source_end', from_us: S, to_us: 2 * S }], {}, '素材终点 1.0 → 2.0 秒', 'Source end 1.0 → 2.0 s'],
    ['track', [{ type: 'track', from: 't1', to: 't2' }], {}, '从 轨道 1 移到 轨道 2', 'Moved from Track 1 to Track 2'],
    ['track from gone', [{ type: 'track', from: 'gone', to: 't2' }], {}, '移到 轨道 2', 'Moved to Track 2'],
    ['track both gone', [{ type: 'track', from: null, to: 'gone' }], {}, '移到其他轨道', 'Moved to another track'],
    ['composition', [{ type: 'composition', from: ROOT_ID, to: 'grp' }], {}, '移到「Intro」', 'Moved to “Intro”'],
    ['composition root', [{ type: 'composition', from: 'grp', to: ROOT_ID }], {}, '移到「主时间线」', 'Moved to “Main timeline”'],
    ['composition gone', [{ type: 'composition', from: ROOT_ID, to: 'gone' }], {}, '移到其他时间线', 'Moved to another timeline'],
    ['speed', [{ type: 'speed', from: 1, to: 2 }], {}, '速度 100% → 200%', 'Speed 100% → 200%'],
    ['speed not constant', [{ type: 'speed', from: 1, to: null }], {}, '变速', 'Speed changed'],
    ['params', [{ type: 'params', keys: ['opacity', 'x'] }], {}, '不透明度、位置 X', 'Opacity, Position X'],
    ['keyframes', [{ type: 'keyframes', keys: ['opacity'] }], {}, '不透明度 关键帧', 'Opacity keyframes'],
    ['units dropped', [{ type: 'params', keys: ['rotation_deg', 'gain_db'] }], {}, '旋转、增益', 'Rotation, Gain'],
    ['effect added', [{ type: 'effect', op: 'added', effect: 'blur' }], {}, '添加效果「模糊」', 'Added effect “Blur”'],
    ['effect removed', [{ type: 'effect', op: 'removed', effect: 'blur' }], {}, '删除效果「模糊」', 'Removed effect “Blur”'],
    ['effect unknown', [{ type: 'effect', op: 'changed', effect: 'nope' }], {}, '修改效果', 'Updated effect'],
    ['label', [{ type: 'label' }], {}, '重命名', 'Renamed'],
    ['enabled', [{ type: 'enabled', value: false }], {}, '禁用', 'Disabled'],
    ['locked', [{ type: 'locked', value: true }], {}, '锁定', 'Locked'],
    ['unlocked', [{ type: 'locked', value: false }], {}, '解锁', 'Unlocked'],
    ['aspect', [{ type: 'aspect', aspect: 'placement' }], {}, '位置', 'Placement'],
  ])('%s', (_name, details, patch, zhText, enText) => {
    expect(say(tZh, details, patch)).toBe(zhText)
    expect(say(tEn, details, patch)).toBe(enText)
  })

  it('an edge measured as a trim is said by the trim alone; the other edge keeps its values', () => {
    const details: ChangeDetail[] = [
      { type: 'time', field: 'start', from_us: 4 * S, to_us: 2 * S },
      { type: 'time', field: 'end', from_us: 6 * S, to_us: 3_500_000 },
      { type: 'time', field: 'source_end', from_us: 6 * S, to_us: 5_500_000 },
      { type: 'trim', side: 'end', delta_us: -500_000 },
    ]
    expect(say(tEn, details)).toBe('Start 4.0 → 2.0 s · Cut 0.5 s from the end')
    expect(statesPlace(change(details))).toBe(false)
    expect(statesPlace(change(details.slice(0, 2)))).toBe(true)
    // A point has no end: its start is its whole place.
    const start = details.slice(0, 1)
    expect(statesPlace(change(start, { ranges: [{ composition_id: 'root', track_id: null, t_start_us: 2 * S, t_end_us: 2 * S }] }))).toBe(true)
    expect(statesPlace(change(start, { ranges: [{ composition_id: 'root', track_id: null, t_start_us: 2 * S, t_end_us: 3 * S }] }))).toBe(false)
  })

  it('names the audio catalog’s effects too', () => {
    expect(say(tEn, [{ type: 'effect', op: 'added', effect: 'audio.denoise' }])).toMatch(/^Added effect “.+”$/)
  })

  it('lists three param names, then counts the rest', () => {
    const keys = ['opacity', 'x', 'scale_x', 'scale_y', 'rotation_deg']
    expect(say(tZh, [{ type: 'params', keys }])).toBe('不透明度、位置 X、缩放 X 等 2 项')
    expect(say(tEn, [{ type: 'params', keys }])).toBe('Opacity, Position X, Scale X and 2 more')
    expect(say(tEn, [{ type: 'keyframes', keys }])).toBe('Opacity, Position X, Scale X and 2 more keyframes')
  })

  it('never shows a raw param key: an unknown one only counts, and alone falls back to the aspect', () => {
    expect(say(tZh, [{ type: 'params', keys: ['opacity', 'mystery'] }])).toBe('不透明度 等 1 项')
    expect(say(tZh, [{ type: 'params', keys: ['mystery'] }])).toBe('属性')
    expect(say(tZh, [{ type: 'keyframes', keys: ['mystery'] }])).toBe('关键帧')
    expect(paramName('mystery', tZh)).toBeNull()
  })

  it('an added change without a length says nothing', () => {
    expect(say(tEn, [], { class: 'added' })).toBe('')
  })
})

describe('change wording locale coverage', () => {
  const at = (loc: unknown, dotted: string): unknown => dotted.split('.').reduce<any>((acc, k) => acc?.[k], loc)
  const extra = ['changes.from_session', 'changes.before_label', 'changes.ghost_label']
  it.each([['en-US', en], ['zh-CN', zh]] as const)('every fact type has its words in %s', (_name, loc) => {
    const keys = [...Object.values(DETAIL_KEYS).flat(), ...extra]
    expect(keys.filter(k => { const v = at(loc, k); return typeof v !== 'string' || v.trim() === '' })).toEqual([])
  })
})
