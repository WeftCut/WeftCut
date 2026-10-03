import { describe, expect, it } from 'vitest';
import { planRetime, type RetimeClip, type RetimePlan, type RetimeTransition } from './retimePlan';
import { AUDIO_GRID, frameGrid } from './grid';
import { timeUsAtFrame } from './eval';
import { contentTiming, exactTime, mapContentTime } from './timeMapping';

function clip(id: string, start = 0, end = 1_000_000, overrides: Partial<RetimeClip> = {}): RetimeClip {
  return {
    id, composition_id: 'root', track_id: 'video', overlap_class: 'visual',
    t_start_us: start, t_end_us: end, locked: false, grid: frameGrid({ num: 30, den: 1 }),
    timing: contentTiming(exactTime(100_000), exactTime(100_000 + end - start)), ...overrides,
  };
}

function rate(clips: RetimeClip[], ids: string[], num: number, den = 1, transitions: RetimeTransition[] = []) {
  return planRetime({ clips, layer_ids: ids, target: { kind: 'Rate', value: exactTime(num, den) }, transitions });
}

function success(plan: RetimePlan) {
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error(JSON.stringify(plan.conflict));
  return plan.edits;
}

describe('retime plans preserve selected content and explicit targets', () => {
  it('changes only the end, preserves source range, and leaves neighbours alone', () => {
    const clips = [clip('first'), clip('next', 1_000_000, 2_000_000)];
    const before = structuredClone(clips);
    const edits = success(rate(clips, ['first'], 2));
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ layer_id: 'first', t_start_us: 0, t_end_us: 500_000, duration_us: 500_000, animation_scale: exactTime(1, 2) });
    expect(edits[0]!.timing.content_in).toEqual(clips[0]!.timing!.content_in);
    expect(edits[0]!.timing.content_out).toEqual(clips[0]!.timing!.content_out);
    expect(clips).toEqual(before);
  });

  it('uses absolute rate on subsequent retimes, including reset', () => {
    const sped = clip('first', 0, 500_000, { timing: contentTiming(exactTime(0), exactTime(1_000_000), exactTime(2)) });
    expect(success(rate([sped], ['first'], 2))[0]!.duration_us).toBe(500_000);
    expect(success(rate([sped], ['first'], 1))[0]!.duration_us).toBe(1_000_000);
  });

  it('interprets Duration per target instead of as a selection total', () => {
    const plan = planRetime({
      clips: [clip('a'), clip('b', 2_000_000, 4_000_000)], layer_ids: ['b', 'a'],
      target: { kind: 'Duration', duration_us: 500_000 }, transitions: [],
    });
    const edits = success(plan);
    expect(edits.map((e) => e.duration_us)).toEqual([500_000, 500_000]);
    expect(edits.map((e) => e.actual_rate)).toEqual([exactTime(2), exactTime(4)]);
  });

  it('does not include unselected linked siblings or let their locks block the edit', () => {
    const video = clip('video');
    const linkedAudio = clip('linked-audio', 0, 1_000_000, { track_id: 'audio', overlap_class: 'audio', grid: AUDIO_GRID, locked: true });
    expect(success(rate([video, linkedAudio], ['video'], 2)).map((e) => e.layer_id)).toEqual(['video']);
    expect(rate([video, linkedAudio], ['video', 'linked-audio'], 2)).toEqual({ ok: false, conflict: { kind: 'Locked', layer_id: 'linked-audio' } });
  });

  it('rejects unsupported content, missing targets and empty selections', () => {
    expect(rate([clip('still', 0, 1_000_000, { timing: null })], ['still'], 2)).toMatchObject({ ok: false, conflict: { kind: 'UnsupportedContent' } });
    expect(rate([], ['missing'], 2)).toMatchObject({ ok: false, conflict: { kind: 'LayerMissing' } });
    expect(rate([], [], 2)).toMatchObject({ ok: false, conflict: { kind: 'EmptyTargets' } });
  });

  it('refuses ancestors and descendants across multiple nested/shared compositions', () => {
    const clips = [
      clip('group', 0, 1_000_000, { composition_ref: 'child' }),
      clip('nested', 0, 1_000_000, { composition_id: 'child', composition_ref: 'grandchild' }),
      clip('leaf', 0, 1_000_000, { composition_id: 'grandchild' }),
    ];
    expect(rate(clips, ['leaf', 'group'], 2)).toEqual({ ok: false, conflict: { kind: 'NestedTargets', ancestor_id: 'group', descendant_id: 'leaf' } });
    expect(success(rate(clips, ['group'], 2))).toHaveLength(1);
  });
});

describe('retime plans validate the entire final layout', () => {
  it('refuses the whole batch with a useful same-lane collision limit', () => {
    const clips = [clip('a'), clip('b', 1_000_000, 2_000_000), clip('other', 0, 1_000_000, { track_id: 'other' })];
    const before = structuredClone(clips);
    const plan = rate(clips, ['other', 'a'], 1, 2);
    expect(plan).toEqual({ ok: false, conflict: {
      kind: 'Collision', layer_id: 'a', blocking_layer_id: 'b', requested_duration: exactTime(2_000_000),
      maximum_duration_us: 1_000_000, minimum_rate: exactTime(1),
    } });
    expect(clips).toEqual(before);
    expect(rate(clips, ['a', 'other'], 1, 2)).toEqual(plan);
  });

  it('accepts exact contact, ignores other lanes and preserves audio/visual coexistence', () => {
    const a = clip('a');
    const b = clip('b', 2_000_000, 3_000_000);
    const overlay = clip('overlay', 0, 3_000_000, { track_id: 'overlay' });
    const audio = clip('audio', 0, 3_000_000, { overlap_class: 'audio', grid: AUDIO_GRID });
    expect(success(rate([a, b, overlay, audio], ['a'], 1, 2))[0]!.t_end_us).toBe(2_000_000);
  });

  it('allows tail growth without treating the existing composition duration as a cap', () => {
    expect(success(rate([clip('a')], ['a'], 1, 10))[0]!.duration_us).toBe(10_000_000);
  });

  const transition: RetimeTransition = { id: 'dissolve', from_layer: 'a', to_layer: 'b', duration_us: 500_000, extended_us: 200_000 };
  const pair = () => [clip('a', 0, 1_500_000), clip('b', 1_000_000, 2_000_000)];

  it('preserves valid transition overlap when the incoming clip changes duration', () => {
    const edits = success(rate(pair(), ['b'], 1, 2, [transition]));
    expect(edits[0]!.t_end_us).toBe(3_000_000);
    expect(transition.duration_us).toBe(500_000);
    expect(transition.extended_us).toBe(200_000);
  });

  it('refuses changed outgoing overlap, including when both participants are selected', () => {
    expect(rate(pair(), ['a'], 2, 1, [transition])).toEqual({ ok: false, conflict: { kind: 'Transition', transition_id: 'dissolve' } });
    expect(rate(pair(), ['a', 'b'], 2, 1, [transition])).toEqual({ ok: false, conflict: { kind: 'Transition', transition_id: 'dissolve' } });
    expect(rate(pair(), ['b'], 4, 1, [transition])).toEqual({ ok: false, conflict: { kind: 'Transition', transition_id: 'dissolve' } });
  });

  it('checks final transition geometry, not an intermediate sequential layout', () => {
    const clips = [clip('a', 0, 1_500_000), clip('b', 1_000_000, 3_000_000)];
    const forward = rate(clips, ['a', 'b'], 1, 1, [transition]);
    expect(success(forward)).toHaveLength(2);
    expect(rate(clips, ['b', 'a'], 1, 1, [transition])).toEqual(forward);
  });
});

describe('retime endpoint quantization', () => {
  it('snaps the absolute NTSC end and derives actual rate from the resulting duration', () => {
    const grid = frameGrid({ num: 30_000, den: 1001 });
    const start = timeUsAtFrame(1, grid.num, grid.den);
    const end = timeUsAtFrame(4, grid.num, grid.den);
    const a = clip('a', start, end, { grid });
    const edit = success(rate([a], ['a'], 3))[0]!;
    expect(edit.t_end_us).toBe(timeUsAtFrame(2, grid.num, grid.den));
    expect(edit.duration_us).toBe(33_366);
    expect(edit.actual_rate).toEqual(exactTime(100_100, 33_366));
    expect(edit.rate_delta.num).not.toBe(0);
    expect(mapContentTime(edit.timing, exactTime(edit.duration_us))).toEqual(a.timing!.content_out);
  });

  it('uses each target grid independently', () => {
    const clips = [clip('video'), clip('audio', 0, 1_000_000, { overlap_class: 'audio', grid: AUDIO_GRID })];
    const edits = success(planRetime({ clips, transitions: [], layer_ids: ['video', 'audio'], target: { kind: 'Duration', duration_us: 123_456 } }));
    const audio = edits.find((e) => e.layer_id === 'audio')!;
    const video = edits.find((e) => e.layer_id === 'video')!;
    expect(audio.duration_us).toBe(123_458);
    expect(video.duration_us).toBe(133_333);
  });

  it('rejects a request rounding to zero instead of silently forcing a frame', () => {
    expect(rate([clip('a')], ['a'], 1_000_000)).toMatchObject({ ok: false, conflict: { kind: 'DurationTooShort' } });
  });

  it('rejects invalid target numbers and out-of-range arithmetic', () => {
    for (const duration_us of [0, -1, NaN, Infinity, 1.5]) {
      expect(planRetime({ clips: [clip('a')], layer_ids: ['a'], target: { kind: 'Duration', duration_us }, transitions: [] })).toMatchObject({ ok: false, conflict: { kind: 'InvalidTarget' } });
    }
    expect(rate([clip('a')], ['a'], 1, Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: false, conflict: { kind: 'Numeric', reason: 'Overflow' } });
  });
});
