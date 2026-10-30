import { expect, it } from 'vitest';
import { av1ProbeArguments } from './hardwareEncoderProbe';
it('uses the exact AMD node and an actual 10-bit upload, not AMF or software encoding', () => {
  const args = av1ProbeArguments('av1_vaapi', 10, '/dev/dri/renderD129');
  expect(args).toContain('/dev/dri/renderD129');
  expect(args).toContain('color=c=black:s=640x360:d=0.1:r=30,format=yuv420p10le');
  expect(args.join(' ')).toContain('format=p010le,hwupload');
  expect(args).toContain('av1_vaapi');
  expect(() => av1ProbeArguments('av1_vaapi', 8, null)).toThrow();
});
it('does not upload VAAPI frames on NVENC', () => {
  expect(av1ProbeArguments('av1_nvenc', 8, null).join(' ')).not.toContain('hwupload');
});
