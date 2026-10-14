// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import en from '../i18n/locales/en-US'
import zh from '../i18n/locales/zh-CN'
import type { Change, ChangeDetail } from '../../shared/review'
import { ROOT_ID, compositionFixture, summaryFixture } from '../testing/summaryFixture'
import type { TrackSummary } from '../ipc'
import { DETAIL_KEYS, changeWordsContext, describeCarried, describeChange, paramName, type Translate } from './changeWords'

const S = 1_000_000
const track = (id: string, label: string | null): TrackSummary => ({ id, kind: 'Video', label, enabled: true, locked: false, muted: false, solo: false, role: null, transient: false, layers: [] })
const summary = summaryFixture({
  root: { tracks: [track('t1', null), track('t2', null)] },
  groups: [compositionFixture({ id: 'grp', label: 'Intro', tracks: [] })],
})
const change = (details: ChangeDetail[], patch: Partial<Change> = {}): Change => ({
  id: 'Layer:x', class: 'modified', kind: 'Layer', keys: ['Layer:x'], aspects: [], details,
  composition_id: ROOT_ID, composition_ids: [ROOT_ID], ranges: [], ...patch,
})

let tEn: Translate, tZh: Translate
beforeAll(() => {
  tEn = i18n.getFixedT('en-US') as unknown as Translate
  tZh = i18n.getFixedT('zh-CN') as unknown as Translate
})
const say = (t: Translate, details: ChangeDetail[], patch?: Partial<Change>) =>
  describeChange(change(details, patch), changeWordsContext(t, summary, new Map([['grp', 1]])))

describe('describeChange', () => {
  it.each<[string, ChangeDetail[], Partial<Change>, string, string]>([
    ['removed length', [{ type: 'length', duration_us: 4 * S }], { class: 'removed' }, '删除 4.0 秒', 'Deleted 4.0 s'],
    ['added length', [{ type: 'length', duration_us: 3 * S }], { class: 'added' }, '时长 3.0 秒', '3.0 s long'],
    ['trim end cut', [{ type: 'trim', side: 'end', delta_us: -1_200_000 }], {}, '结尾剪掉 1.2 秒', 'Cut 1.2 s from the end'],
    ['trim start cut', [{ type: 'trim', side: 'start', delta_us: -500_000 }], {}, '开头剪掉 0.5 秒', 'Cut 0.5 s from the start'],
    ['trim end extend', [{ type: 'trim', side: 'end', delta_us: S }], {}, '结尾延长 1.0 秒', 'Extended end by 1.0 s'],
    ['shift earlier', [{ type: 'shift', delta_us: -2 * S }], {}, '前移 2.0 秒', 'Moved 2.0 s earlier'],
    ['shift later', [{ type: 'shift', delta_us: 1_250_000 }], {}, '后移 1.25 秒', 'Moved 1.25 s later'],
    ['slip later', [{ type: 'slip', delta_us: 400_000 }], {}, '素材选段后移 0.4 秒', 'Slipped source 0.4 s later'],
    ['slip earlier', [{ type: 'slip', delta_us: -400_000 }], {}, '素材选段前移 0.4 秒', 'Slipped source 0.4 s earlier'],
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
    ['facts joined', [{ type: 'shift', delta_us: -2 * S }, { type: 'label' }], {}, '前移 2.0 秒 · 重命名', 'Moved 2.0 s earlier · Renamed'],
  ])('%s', (_name, details, patch, zhText, enText) => {
    expect(say(tZh, details, patch)).toBe(zhText)
    expect(say(tEn, details, patch)).toBe(enText)
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

  it('a change without facts says its aspects; an added one without either says nothing', () => {
    expect(say(tEn, [], { aspects: ['timing', 'params'] })).toBe('Timing · Properties')
    expect(say(tEn, [], { class: 'added' })).toBe('')
  })
})

describe('describeCarried', () => {
  const carried = (keys: Change['keys'], delta_us: number) => change([{ type: 'shift', delta_us }], { keys, delta_us, carried: true, carried_by: 'Layer:x' })
  it('counts the clips (and markers) the edit carried, and which way', () => {
    const five = carried(['Layer:a', 'Layer:b', 'Layer:c', 'Layer:d', 'Layer:e'], -4 * S)
    expect(describeCarried(five, tZh)).toBe('后面 5 个片段随之前移 4.0 秒')
    expect(describeCarried(five, tEn)).toBe('5 clips after it moved 4.0 s earlier')
    const mixed = carried(['Layer:a', 'Marker:m', 'Marker:n'], 1_500_000)
    expect(describeCarried(mixed, tZh)).toBe('后面 1 个片段和 2 个标记随之后移 1.5 秒')
    expect(describeCarried(mixed, tEn)).toBe('1 clip and 2 markers after it moved 1.5 s later')
  })
})

describe('change wording locale coverage', () => {
  const at = (loc: unknown, dotted: string): unknown => dotted.split('.').reduce<any>((acc, k) => acc?.[k], loc)
  const extra = ['changes.detail.carried_earlier', 'changes.detail.carried_later', 'changes.detail.clips_and_markers', 'changes.from_session']
  it.each([['en-US', en], ['zh-CN', zh]] as const)('every fact type has its words in %s', (_name, loc) => {
    const keys = [...Object.values(DETAIL_KEYS).flat(), ...extra]
    expect(keys.filter(k => { const v = at(loc, k); return typeof v !== 'string' || v.trim() === '' })).toEqual([])
  })
})
