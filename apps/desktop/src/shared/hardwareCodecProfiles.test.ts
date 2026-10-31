import { expect, it } from 'vitest';
import { diagnosticFixture, hardwareDecodeProfiles } from './hardwareCodecProfiles';
it('tests independent HEVC/VP9/AV1 8/10-bit profiles without inventing AVC High10', () => {
  expect(hardwareDecodeProfiles).toHaveLength(7);
  for (const codec of ['hevc', 'vp9', 'av1'] as const) {
    expect(hardwareDecodeProfiles.filter(p => p.codec === codec).map(p => p.bitDepth)).toEqual([8, 10]);
    expect(diagnosticFixture(codec, 10).pixFmt).toBe('yuv420p10le');
    expect(diagnosticFixture(codec, 10).filename).not.toBe(diagnosticFixture(codec, 8).filename);
  }
  expect(diagnosticFixture('av1', 8).encoder).toBe('libsvtav1');
});
