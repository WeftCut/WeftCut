// apps/desktop/bench/checklist.test.mjs — `node --test bench/checklist.test.mjs`
//
// The checklist evaluator against small hand-built projects in the
// `project://current` shape, plus a lint over every bench task file so a typo
// in a check kind, a regex or a setup tool name fails here rather than
// mid-run.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CHECK_KINDS, evaluateChecklist } from './checklist.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const S = 1_000_000

// ── Builders ────────────────────────────────────────────────────────────────

let seq = 0
const id = (p) => `${p}-${++seq}`
const stat = (value) => ({ mode: 'Static', value })
const transform = (x = 960, y = 540) => ({ position: { mode: 'XY', x: stat(x), y: stat(y) }, scale_x: stat(1), scale_y: stat(1), rotation_deg: stat(0), anchor_x: stat(0.5), anchor_y: stat(0.5), scale_linked: true })

const layer = (t0, t1, params, extra = {}) => ({ id: id('l'), label: null, t_start_us: t0 * S, t_end_us: t1 * S, enabled: true, locked: false, metadata: {}, params, effects: [], ...extra })
const video = (t0, t1, src0 = t0, media = 'm1') => layer(t0, t1, { kind: 'VideoClip', media, src_in_us: src0 * S, src_out_us: (src0 + t1 - t0) * S, transform: transform() })
const audio = (t0, t1, src0 = t0, media = 'm1') => layer(t0, t1, { kind: 'Audio', media, src_in_us: src0 * S, src_out_us: (src0 + t1 - t0) * S, role: 'dialogue' })
const text = (t0, t1, content, x, y) => layer(t0, t1, { kind: 'Text', content, transform: transform(x, y) })
const motif = (t0, t1, motif_id, props = {}) => layer(t0, t1, { kind: 'Motif', motif_id, motif_version: 1, props, src_in_us: 0, transform: transform() })
const track = (layers, extra = {}) => ({ id: id('t'), label: null, enabled: true, locked: false, removable: true, role: null, transient: true, height_px: 64, layers, ...extra })
const captionTrack = (layers) => track(layers, { role: 'Caption', transient: false })

function project(tracks, { fps = { num: 25, den: 1 }, audioStream = true } = {}) {
  return {
    schema_version: 4, project_id: 'p', root_id: 'root',
    compositions: { root: { id: 'root', label: null, ordinal: 0, width: 1920, height: 1080, fps, duration_us: 0, duration_pinned: false, tracks, markers: [], transitions: [], links: [] } },
    media_pool: { m1: { id: 'm1', kind: 'Video', metadata: { duration_us: 200 * S, audio: audioStream ? { channels: 2 } : null } } },
    audio_roles: {}, settings: {},
  }
}

/** One check, one result — the common case in these tests. */
function check(c, proj) {
  const [r] = evaluateChecklist({ checklist: [{ id: 'x', description: '', check: c }] }, proj)
  return r
}

// ── Evaluator ──────────────────────────────────────────────────────────────

describe('evaluateChecklist', () => {
  it('returns one result per item, in order, with ids', () => {
    const p = project([track([video(0, 10)])])
    const out = evaluateChecklist({ checklist: [
      { id: 'a', description: '', check: { kind: 'layer_count', op: '==', n: 1, where: { layer_kind: 'VideoClip' } } },
      { id: 'b', description: '', check: { kind: 'human' } },
    ] }, p)
    assert.deepEqual(out.map((r) => [r.id, r.pass]), [['a', true], ['b', null]])
  })

  it('fails machine items and keeps human ones null when there is no project', () => {
    const out = evaluateChecklist({ checklist: [
      { id: 'a', description: '', check: { kind: 'no_gaps' } },
      { id: 'b', description: '', check: { kind: 'human' } },
    ] }, null)
    assert.deepEqual(out.map((r) => r.pass), [false, null])
  })

  it('reports an unknown kind as not checkable instead of throwing', () => {
    const r = check({ kind: 'nope' }, project([]))
    assert.equal(r.pass, null)
    assert.match(r.detail, /unknown check kind/)
  })
})

describe('layer_count and selectors', () => {
  const p = project([
    track([video(0, 20)]),
    track([text(0, 3, 'How memory works'), text(5, 9, 'Lisa Genzel\nNeuroscientist', 300, 900, )]),
    track([motif(70, 74, 'callout-pin', { label: 'Hippocampus', style: { tone: 'warm' } }), motif(10, 14, 'lower-third', { name: 'Someone' })]),
    captionTrack([text(0, 2, 'do you remember'), text(2, 4, 'what you had for lunch')]),
    track([text(0, 20, 'hidden')], { enabled: false }),
  ])

  it('filters by kind, caption track and disabled state', () => {
    assert.equal(check({ kind: 'layer_count', op: '==', n: 2, where: { layer_kind: 'Text', caption: false } }, p).pass, true)
    assert.equal(check({ kind: 'layer_count', op: '==', n: 2, where: { caption: true } }, p).pass, true)
    assert.equal(check({ kind: 'layer_count', op: '==', n: 3, where: { layer_kind: 'Text', caption: false, include_disabled: true } }, p).pass, true)
  })

  it('reads Motif props (nested too) as visible text', () => {
    assert.equal(check({ kind: 'text_layer_matching', text_regex: 'hippocamp' }, p).pass, true)
    assert.equal(check({ kind: 'text_layer_matching', text_regex: 'warm' }, p).pass, true)
  })

  it('reads a phrase split across props or lines as one phrase', () => {
    const split = project([track([
      motif(0, 4, 'card', { line_one: 'What is', line_two: 'a memory?' }),
      text(5, 8, 'Lisa\nGenzel'),
    ])])
    assert.equal(check({ kind: 'text_layer_matching', text_regex: 'what is a memory' }, split).pass, true)
    assert.equal(check({ kind: 'text_layer_matching', text: 'Lisa Genzel' }, split).pass, true)
  })

  it('excludes captions from text_layer_matching unless asked', () => {
    assert.equal(check({ kind: 'text_layer_matching', text_regex: 'lunch' }, p).pass, false)
    assert.equal(check({ kind: 'text_layer_matching', text_regex: 'lunch', where: { caption: true } }, p).pass, true)
  })

  it('honours flags: "" makes the match case-sensitive', () => {
    assert.equal(check({ kind: 'text_layer_matching', text_regex: 'lisa genzel' }, p).pass, true)
    assert.equal(check({ kind: 'text_layer_matching', text_regex: 'lisa genzel', flags: '' }, p).pass, false)
  })

  it('applies time windows and durations', () => {
    const w = (where) => check({ kind: 'text_layer_matching', text_regex: 'hippocamp', where }, p).pass
    assert.equal(w({ starts_at_or_after_s: 60, starts_before_s: 100, min_duration_s: 1.5 }), true)
    assert.equal(w({ starts_before_s: 70 }), false)
    assert.equal(w({ min_duration_s: 5 }), false)
    assert.equal(w({ ends_at_or_before_s: 74 }), true)
  })

  it('tells built-in Motifs from authored ones', () => {
    assert.equal(check({ kind: 'motif_layer_count', op: '==', n: 1, where: { motif_builtin: false } }, p).pass, true)
    assert.equal(check({ kind: 'motif_layer_count', op: '==', n: 1, where: { motif_builtin: true } }, p).pass, true)
    assert.equal(check({ kind: 'motif_layer_count', op: '==', n: 2 }, p).pass, true)
    assert.equal(check({ kind: 'layer_count', op: '>=', n: 1, where: { motif_id: ['callout-pin'] } }, p).pass, true)
  })

  it('selects layers by graphic role, null for untagged', () => {
    const titled = motif(0, 4, 'clipping-headline', { text: 'What is a memory?' })
    titled.params.graphic_role = 'title'
    const card = text(0, 4, 'plain card')
    card.params.graphic_role = null
    const q = project([track([titled, card])])
    assert.equal(check({ kind: 'motif_layer_count', op: '==', n: 1, where: { graphic_role: 'title' } }, q).pass, true)
    assert.equal(check({ kind: 'layer_count', op: '==', n: 2, where: { graphic_role: ['title', null] } }, q).pass, true)
    assert.equal(check({ kind: 'layer_count', op: '==', n: 0, where: { graphic_role: 'callout' } }, q).pass, true)
    assert.equal(check({ kind: 'motif_layer_count', op: '==', n: 1, where: { motif_builtin: true } }, q).pass, true)
  })

  it('counts jump cuts on the A roll and what covers them', () => {
    const aroll = (layers) => track(layers, { role: 'ARoll' })
    const punched = video(20, 30, 25); punched.params.transform.scale_x = stat(1.15); punched.params.transform.scale_y = stat(1.15)
    const group = layer(8, 12, { kind: 'CompositionRef', composition: 'c1', src_in_us: 0, src_out_us: 4 * S, transform: transform() })
    const p = project([aroll([video(0, 5, 0), video(5, 10, 6), video(10, 20, 12), punched, video(30, 40, 40)]), track([group])])
    const r = check({ kind: 'jump_cuts', max_uncovered_fraction: 0.5 }, p)
    // Cuts at 5 (bare), 10 (the group), 20 (punch-in), 30 (punching back out is a scale change too).
    assert.equal(r.pass, true)
    assert.match(r.detail, /4 jump cut\(s\), 3 covered \(scene 1, punch-in 2\), 25% bare, want <= 50%; bare at 5s/)
    assert.equal(check({ kind: 'jump_cuts' }, p).pass, null)
    // A continuous source is no jump cut.
    assert.match(check({ kind: 'jump_cuts' }, project([aroll([video(0, 5, 0), video(5, 10, 5)])])).detail, /no jump cuts/)
  })

  it('asks each scene Group for a picture', () => {
    const scene = (cid, layers) => ({ id: cid, label: null, ordinal: 1, width: 1920, height: 1080, fps: { num: 25, den: 1 }, duration_us: 0, duration_pinned: false, tracks: [track(layers)], markers: [], transitions: [], links: [] })
    const group = (t0, cid) => layer(t0, t0 + 6, { kind: 'CompositionRef', composition: cid, src_in_us: 0, src_out_us: 6 * S, transform: transform() })
    const p = project([track([video(0, 60)], { role: 'ARoll' }), track([group(5, 'words'), group(20, 'sticker'), group(40, 'one')])])
    p.compositions.words = scene('words', [motif(0, 6, 'clipping-paper'), motif(1, 6, 'clipping-reveal', { text: 'CORTEX' })])
    p.compositions.sticker = scene('sticker', [motif(0, 6, 'clipping-paper'), motif(1, 6, 'clipping-sticker', { photo: 'm1@60000000' })])
    p.compositions.one = scene('one', [motif(0, 6, 'clipping-headline')])
    const r = check({ kind: 'scene_pictures', min_fraction: 1 }, p)
    assert.equal(r.pass, false)
    assert.match(r.detail, /^1 of 2 scene\(s\) hold a picture; words only at 5s$/)
    assert.equal(check({ kind: 'scene_pictures' }, p).pass, null)
    assert.match(check({ kind: 'scene_pictures', min_fraction: 1 }, project([track([video(0, 10)])])).detail, /no scene Groups/)
  })

  it('measures the longest stretch of bare A roll', () => {
    const p = project([track([video(0, 60)], { role: 'ARoll' }), captionTrack([text(0, 60, 'all of it')]), track([motif(10, 14, 'callout-pin'), motif(40, 44, 'callout-pin')])])
    const r = check({ kind: 'bare_talk', max_s: 20 }, p)
    assert.equal(r.pass, false)
    assert.match(r.detail, /26 s from 14 s/)
  })

  it('supports every comparison op', () => {
    const n = (op, k) => check({ kind: 'layer_count', op, n: k, where: { layer_kind: 'Motif' } }, p).pass
    assert.deepEqual([n('>=', 2), n('<=', 2), n('==', 2), n('!=', 2), n('>', 1), n('<', 3)], [true, true, true, false, true, true])
  })
})

describe('smoke-task kinds', () => {
  const p = project([track([text(0, 2, 'Hello Bench')])], { fps: { num: 30, den: 1 } })

  it('text_layer_contains', () => {
    assert.equal(check({ kind: 'text_layer_contains', text: 'Hello Bench' }, p).pass, true)
    assert.equal(check({ kind: 'text_layer_contains', text: 'hello bench' }, p).pass, false)
  })

  it('layer_span with tolerance', () => {
    assert.equal(check({ kind: 'layer_span', text: 'Hello Bench', t_start_us: 0, t_end_us: 2_000_000, tolerance_us: 100_000 }, p).pass, true)
    assert.equal(check({ kind: 'layer_span', text: 'Hello Bench', t_start_us: 0, t_end_us: 2_500_000, tolerance_us: 100_000 }, p).pass, false)
    assert.equal(check({ kind: 'layer_span', text: 'Missing', t_start_us: 0 }, p).pass, false)
  })
})

describe('captions', () => {
  const footage = track([video(0, 10)])

  it('caption_track_present counts cues across caption tracks', () => {
    const p = project([footage, captionTrack([text(0, 2, 'a'), text(2, 4, 'b')]), captionTrack([text(3, 5, 'c')])])
    assert.equal(check({ kind: 'caption_track_present', min_cues: 3 }, p).pass, true)
    assert.equal(check({ kind: 'caption_track_present', min_cues: 4 }, p).pass, false)
    assert.equal(check({ kind: 'caption_track_present' }, project([footage])).pass, false)
  })

  it('a Text layer on a plain track is not a caption', () => {
    assert.equal(check({ kind: 'caption_track_present' }, project([footage, track([text(0, 2, 'title')])])).pass, false)
  })

  it('caption_coverage is the cue union over the programme length', () => {
    const p = project([footage, captionTrack([text(0, 4, 'a'), text(3, 7, 'b')])])
    assert.equal(check({ kind: 'caption_coverage', min_fraction: 0.7 }, p).pass, true)
    assert.equal(check({ kind: 'caption_coverage', min_fraction: 0.75 }, p).pass, false)
  })

  it('captions_over_picture catches cues left over a gap or past the end', () => {
    const ok = project([footage, captionTrack([text(0, 4, 'a'), text(6, 10, 'b')])])
    assert.equal(check({ kind: 'captions_over_picture' }, ok).pass, true)
    const stale = project([track([video(0, 6)]), captionTrack([text(0, 4, 'a'), text(6, 10, 'b')])])
    const r = check({ kind: 'captions_over_picture' }, stale)
    assert.equal(r.pass, false)
    assert.match(r.detail, /50\.0%/)
    assert.equal(check({ kind: 'captions_over_picture', min_fraction: 0.5 }, stale).pass, true)
  })
})

describe('timeline_duration', () => {
  const p = project([track([video(0, 30), video(40, 60, 100)]), track([text(58, 65, 'end card')])])

  it('content measures the end of the last enabled layer', () => {
    assert.equal(check({ kind: 'timeline_duration', min_s: 64, max_s: 66 }, p).pass, true)
    assert.equal(check({ kind: 'timeline_duration', max_s: 60 }, p).pass, false)
  })

  it('video measures the time footage covers', () => {
    const r = check({ kind: 'timeline_duration', measure: 'video', min_s: 50, max_s: 50 }, p)
    assert.equal(r.pass, true, r.detail)
  })
})

describe('gaps', () => {
  it('no_gaps passes a ripple-closed cut spread over two tracks', () => {
    const p = project([track([video(0, 10), video(20, 30, 40)]), track([video(10, 20, 22)])])
    assert.equal(check({ kind: 'no_gaps' }, p).pass, true)
  })

  it('no_gaps finds a hole and a late start, and tolerates one frame', () => {
    const holey = project([track([video(0, 10), video(12, 20, 15)])])
    const r = check({ kind: 'no_gaps' }, holey)
    assert.equal(r.pass, false)
    assert.match(r.detail, /10-12s/)
    assert.equal(check({ kind: 'no_gaps' }, project([track([video(1, 10)])])).pass, false)
    assert.equal(check({ kind: 'no_gaps' }, project([track([video(0, 10), video(10.04, 20, 30)])])).pass, true)
    assert.equal(check({ kind: 'no_gaps', tolerance_s: 3 }, holey).pass, true)
  })

  it('no_gaps_on_track judges each track on its own', () => {
    const p = project([track([video(0, 10), video(20, 30, 40)]), track([video(10, 20, 22)])])
    assert.equal(check({ kind: 'no_gaps_on_track' }, p).pass, false)
    assert.equal(check({ kind: 'no_gaps_on_track' }, project([track([video(0, 10), video(10, 20, 30)])])).pass, true)
  })

  it('no matching layers fails rather than passing vacuously', () => {
    assert.equal(check({ kind: 'no_gaps' }, project([])).pass, false)
  })
})

describe('av_sync', () => {
  it('passes when every clip has same-media sound on the same span and window', () => {
    const p = project([track([video(0, 10), audio(0, 10), video(10, 20, 15), audio(10, 20, 15)])])
    assert.equal(check({ kind: 'av_sync' }, p).pass, true)
  })

  it('fails a clip whose sound slipped or was deleted', () => {
    const slipped = project([track([video(0, 10), audio(0.5, 10.5, 0.5)])])
    assert.equal(check({ kind: 'av_sync' }, slipped).pass, false)
    const wrongWindow = project([track([video(0, 10), audio(0, 10, 3)])])
    assert.equal(check({ kind: 'av_sync' }, wrongWindow).pass, false)
    const silent = project([track([video(0, 10)])])
    assert.equal(check({ kind: 'av_sync' }, silent).pass, false)
  })

  it('is not checkable when the media has no sound', () => {
    assert.equal(check({ kind: 'av_sync' }, project([track([video(0, 10)])], { audioStream: false })).pass, null)
  })
})

describe('layer_region', () => {
  const lt = { kind: 'layer_region', where: { caption: false, text_regex: 'Genzel' }, y: [0.55, 1] }

  it('checks the resting anchor of Text layers as frame fractions', () => {
    assert.equal(check(lt, project([track([text(0, 4, 'Lisa Genzel', 300, 900)])])).pass, true)
    assert.equal(check(lt, project([track([text(0, 4, 'Lisa Genzel')])])).pass, false)
  })

  it('uses the last key of an animated position', () => {
    const t = text(0, 4, 'Lisa Genzel')
    t.params.transform.position.y = { mode: 'Keyframed', value: [{ t_us: 0, value: 1200 }, { t_us: 500000, value: 920 }], extrapolate: {} }
    assert.equal(check(lt, project([track([t])])).pass, true)
  })

  it('is not checkable when only Motifs match', () => {
    assert.equal(check(lt, project([track([motif(0, 4, 'lower-third', { name: 'Lisa Genzel' })])])).pass, null)
  })

  it("require 'any' passes when one of several Text layers is in range", () => {
    const p = project([track([text(0, 4, 'Lisa Genzel', 960, 540)]), track([text(0, 4, 'Genzel, Radboud', 300, 950)])])
    assert.equal(check(lt, p).pass, false)
    assert.equal(check({ ...lt, require: 'any' }, p).pass, true)
  })
})

describe('combinators', () => {
  const p = project([track([video(0, 10)])])
  const yes = { kind: 'layer_count', op: '>=', n: 1, where: { layer_kind: 'VideoClip' } }
  const no = { kind: 'layer_count', op: '>=', n: 1, where: { layer_kind: 'Motif' } }
  const maybe = { kind: 'human' }

  it('all_of: any false fails, else any null is null', () => {
    assert.equal(check({ kind: 'all_of', checks: [yes, yes] }, p).pass, true)
    assert.equal(check({ kind: 'all_of', checks: [yes, no, maybe] }, p).pass, false)
    assert.equal(check({ kind: 'all_of', checks: [yes, maybe] }, p).pass, null)
  })

  it('any_of: any true passes, else any null is null', () => {
    assert.equal(check({ kind: 'any_of', checks: [no, yes] }, p).pass, true)
    assert.equal(check({ kind: 'any_of', checks: [no, maybe] }, p).pass, null)
    assert.equal(check({ kind: 'any_of', checks: [no, no] }, p).pass, false)
  })
})

// ── Task files ─────────────────────────────────────────────────────────────

/** Every tool name the app serves: the TS registry plus the Rust catalog. */
function mcpToolNames() {
  const ts = fs.readFileSync(path.join(HERE, '..', 'src', 'main', 'state', 'mcp-commands.ts'), 'utf8')
  const names = new Set([...ts.matchAll(/\{\s*name:\s*'([a-z_]+)'/g)].map((m) => m[1]))
  const rust = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'mcp', 'rust-catalog-snapshot.json'), 'utf8'))
  for (const t of rust.tools) names.add(t.name)
  return names
}

function walkChecks(c, visit) {
  visit(c)
  if (c.kind === 'all_of' || c.kind === 'any_of') for (const sub of c.checks) walkChecks(sub, visit)
}

describe('task files', () => {
  const dir = path.join(HERE, 'tasks')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  const tools = mcpToolNames()
  const fixtureIds = new Set(JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'fixtures.json'), 'utf8')).fixtures.map((f) => f.id))

  it('found the tool registry', () => {
    for (const t of ['import_media', 'add_track', 'add_video_layer', 'read_project']) assert.ok(tools.has(t), t)
  })

  for (const file of files) {
    it(`${file}: setup tools exist, fixtures are known, checks are well-formed`, () => {
      const task = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      assert.equal(`${task.id}.json`, file)
      for (const f of task.fixtures) assert.ok(fixtureIds.has(f), `unknown fixture ${f}`)
      for (const step of task.setup) {
        assert.ok(tools.has(step.tool), `unknown MCP tool ${step.tool}`)
        for (const m of JSON.stringify(step.args).matchAll(/\{fixture:([^}]+)\}/g)) assert.ok(task.fixtures.includes(m[1]), `{fixture:${m[1]}} not in fixtures`)
      }
      const ids = new Set()
      for (const item of task.checklist) {
        assert.ok(!ids.has(item.id), `duplicate checklist id ${item.id}`)
        ids.add(item.id)
        assert.ok(item.description, `${item.id} has no description`)
        walkChecks(item.check, (c) => {
          assert.ok(CHECK_KINDS.includes(c.kind), `${item.id}: unknown check kind ${c.kind}`)
          for (const re of [c.text_regex, c.where?.text_regex]) if (re !== undefined) new RegExp(re)
        })
      }
      // Scoring an empty project must not throw and must answer every item.
      const empty = project([])
      assert.equal(evaluateChecklist(task, empty).length, task.checklist.length)
    })
  }
})
