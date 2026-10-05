import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalibrationPlan, executionOf } from './calibration-plan.mjs';

const input = () => ({ fixtureSet: 'short', fixtures: ['h264-1080', 'h264-2160', 'hevc-1080', 'hevc-2160'], tracks: [1, 2, 3], windowS: 4, warmupS: 1.5, quietS: 15, seek: true, motif: true });

test('same inputs produce the same plan regardless of prior scores or changing free memory', () => {
  const first = createCalibrationPlan(input());
  const repeated = createCalibrationPlan({ ...input(), history: [{ stableTracks: 8 }], freeMemoryBytes: 1, currentSettings: { preview_gpu_sessions: 32 } });
  assert.deepEqual(repeated, first);
  assert.equal(first.scenarios.flatMap(s => s.windows).length, 18);
  assert.equal(first.scenarios.flatMap(s => s.seekTargetsUs).length, 16);
});

test('plan is detached from caller arrays and cannot be changed by later measurements', () => {
  const config = input();
  const plan = createCalibrationPlan(config);
  config.tracks.push(4);
  config.fixtures.reverse();
  assert.deepEqual(plan, createCalibrationPlan(input()));
  assert.throws(() => plan.scenarios[0].windows.pop(), TypeError);
  assert.throws(() => { plan.initialSettings.performance.frame_ring_mib = 8192; }, TypeError);
});

test('measurement failure remains recorded and cannot remove later scheduled items', () => {
  const plan = createCalibrationPlan(input());
  const rows = executionOf(plan, { samples: [{ cell: plan.scenarios[0].windows[0].cell, observation: 'dropped frames' }], seeks: [], errors: [{ cell: 'h264-1080', error: 'renderer crashed' }], finishedAt: 'ended' });
  assert.equal(rows.length, 34);
  assert.equal(rows[0].status, 'recorded');
  assert.equal(rows[0].reason, null);
  assert.equal(rows[1].status, 'not-run');
  assert.equal(rows[1].reason, 'renderer crashed');
  assert.equal(plan.scenarios[0].windows.length, 4);
});

test('explicit configuration changes identify a different plan and invalid sequences reject', () => {
  assert.notEqual(createCalibrationPlan(input()).id, createCalibrationPlan({ ...input(), windowS: 5 }).id);
  assert.equal(createCalibrationPlan({ ...input(), fixtureSet: 'full' }).scenarios[0].seekTargetsUs[2], 24_000_000);
  assert.throws(() => createCalibrationPlan({ ...input(), tracks: [2, 1] }));
  assert.throws(() => createCalibrationPlan({ ...input(), fixtures: ['h264-1080', 'h264-1080'] }));
  assert.throws(() => createCalibrationPlan({ ...input(), windowS: 20 }));
});
