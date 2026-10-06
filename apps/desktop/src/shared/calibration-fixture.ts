/** Versioned synthetic input recipe shared by the app and developer runner. */
export const CALIBRATION_FIXTURE_RECIPE = Object.freeze({
  version: 1, codec: 'h264', width: 3840, height: 2160, fps: 60,
  durationUs: 20_000_000, gopFrames: 480, pixelFormat: 'yuv420p',
});

export interface CalibrationFixture {
  path: string;
  width: number;
  height: number;
  fps: number;
  durationUs: number;
  sha256: string;
  bytes: number;
}

export function calibrationFixtureArgs(output: string): string[] {
  return ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=60',
    '-t', '20', '-an', '-c:v', 'libx264', '-preset', 'fast', '-threads', '4', '-profile:v', 'high',
    '-b:v', '40M', '-g', '480', '-keyint_min', '480', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', output];
}

export function validateFixtureProbe(probe: unknown): void {
  const input = probe as { streams?: Array<Record<string, unknown>>; format?: { duration?: unknown } } | null;
  const stream = input?.streams?.[0];
  for (const [key, expected] of Object.entries({ codec_name: 'h264', width: 3840, height: 2160,
    pix_fmt: 'yuv420p', avg_frame_rate: '60/1', nb_frames: '1200' })) {
    if (stream?.[key] !== expected) throw new Error(`Invalid calibration fixture ${key}: ${stream?.[key]}`);
  }
  const duration = Number(input?.format?.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - 20) > .05) throw new Error('Invalid fixture duration');
}
