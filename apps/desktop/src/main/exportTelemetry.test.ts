import { expect, it } from 'vitest';
import { encoderForExport, nvidiaEncoderLoad } from './exportTelemetry';

it('reports the actual matching export encoder, including software fallback from auto', () => {
  const argv = ['/opt/app/ffmpeg.native', '-f', 'rawvideo', '-i', '-', '-c:v', 'h264_nvenc', '/tmp/export-a.mp4'];
  expect(encoderForExport(argv, '/tmp/export-a.mp4')).toEqual({ encoder: 'h264_nvenc', device: 'gpu' });
  expect(encoderForExport(argv, '/tmp/export-b.mp4')).toBeNull();
  argv[6] = 'libx264';
  expect(encoderForExport(argv, '/tmp/export-a.mp4')).toEqual({ encoder: 'libx264', device: 'cpu' });
  argv[6] = 'mystery';expect(encoderForExport(argv, '/tmp/export-a.mp4')).toBeNull();
  expect(encoderForExport(['/usr/bin/node', '-c:v', 'libx264', '/tmp/export-a.mp4'], '/tmp/export-a.mp4')).toBeNull();
});
it('keeps valid zero load but never fabricates missing or ambiguous GPU telemetry', () => {
  expect(nvidiaEncoderLoad('0\n')).toBe(0);
  expect(nvidiaEncoderLoad(' 53 \n')).toBe(53);
  for (const value of ['', '[N/A]', 'Not Supported', '101', '-1', 'NaN', '0\n95']) expect(nvidiaEncoderLoad(value)).toBeNull();
});
