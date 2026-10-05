import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFixtureProbe } from './gen-playback-calibration-fixture.mjs';

const probe = () => ({ streams: [{ codec_name: 'h264', width: 3840, height: 2160,
  pix_fmt: 'yuv420p', avg_frame_rate: '60/1', nb_frames: '1200' }], format: { duration: '20.000000' } });

test('accepts the genuine 4K60 reference and rejects old 30fps or shortened inputs', () => {
  assert.doesNotThrow(() => validateFixtureProbe(probe()));
  for (const patch of [{ avg_frame_rate: '30/1' }, { nb_frames: '600' }, { codec_name: 'hevc' },
    { width: 1920 }, { pix_fmt: 'yuv420p10le' }]) {
    const input = probe(); Object.assign(input.streams[0], patch);
    assert.throws(() => validateFixtureProbe(input), /Invalid calibration fixture/);
  }
});

test('requires a finite, full-length reference duration', () => {
  for (const duration of [undefined, 'NaN', 'Infinity', '4.0']) {
    const input = probe(); input.format.duration = duration;
    assert.throws(() => validateFixtureProbe(input), /Invalid fixture duration/);
  }
});
