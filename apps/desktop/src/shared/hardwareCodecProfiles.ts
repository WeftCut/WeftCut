import type { CodecHardwareProbe } from './hardware-diagnostics';

export const hardwareDecodeProfiles = [
  { codec: 'h264', bitDepth: 8 },
  { codec: 'hevc', bitDepth: 8 }, { codec: 'hevc', bitDepth: 10 },
  { codec: 'vp9', bitDepth: 8 }, { codec: 'vp9', bitDepth: 10 },
  { codec: 'av1', bitDepth: 8 }, { codec: 'av1', bitDepth: 10 },
] as const;

export function diagnosticFixture(codec: CodecHardwareProbe['codec'], bitDepth: 8 | 10) {
  const encoder = { h264: 'libx264', hevc: 'libx265', vp9: 'libvpx-vp9', av1: 'libsvtav1' }[codec];
  const tuning = codec === 'hevc' ? ['-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1']
    : codec === 'h264' ? ['-preset', 'ultrafast'] : codec === 'av1' ? ['-preset', '12', '-svtav1-params', 'lp=1']
    : ['-deadline', 'realtime', '-cpu-used', '8'];
  return { encoder, tuning, pixFmt: bitDepth === 10 ? 'yuv420p10le' : 'yuv420p',
    filename: `${codec}-${bitDepth}.${codec === 'vp9' ? 'webm' : 'mp4'}` };
}
