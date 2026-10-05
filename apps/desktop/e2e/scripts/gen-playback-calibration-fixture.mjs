// Genuine 60 fps input for the controlled playback calibration host.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const fixtureDirectory = path.join(desktop, 'e2e/fixtures/decode-bench/calibration-60');
export const fixturePath = path.join(fixtureDirectory, 'h264-4k60.mp4');
export const manifestPath = path.join(fixtureDirectory, 'manifest.json');
const binary = name => process.env[name.toUpperCase()] || (process.platform === 'win32'
  ? path.join(desktop, 'resources/ffmpeg/win', `${name}.exe`) : name);
function run(name, args) {
  const result = spawnSync(binary(name), args, { encoding: 'utf8', windowsHide: true, timeout: 600_000 });
  if (result.error || result.status !== 0) throw new Error(`${name}: ${result.error ?? result.stderr}`);
  return result.stdout;
}
export function validateFixtureProbe(probe) {
  const stream = probe.streams?.[0];
  for (const [key, expected] of Object.entries({ codec_name: 'h264', width: 3840, height: 2160,
    pix_fmt: 'yuv420p', avg_frame_rate: '60/1', nb_frames: '1200' })) {
    if (stream?.[key] !== expected) throw new Error(`Invalid calibration fixture ${key}: ${stream?.[key]}`);
  }
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - 20) > .05) throw new Error('Invalid fixture duration');
}
export function readFixture() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const hash = createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');
  if (manifest.version !== 1 || manifest.sha256 !== hash || manifest.fps !== 60 || manifest.width !== 3840
    || manifest.height !== 2160 || manifest.codec !== 'h264' || manifest.durationUs !== 20_000_000) {
    throw new Error('Calibration fixture or manifest changed; regenerate fixtures');
  }
  return { ...manifest, path: fixturePath };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--windows-only') && process.platform !== 'win32') process.exit(0);
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  if (!fs.existsSync(fixturePath) || process.argv.includes('--force')) {
    run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=60',
      '-t', '20', '-an', '-c:v', 'libx264', '-preset', 'fast', '-threads', '4', '-profile:v', 'high',
      '-b:v', '40M', '-g', '480', '-keyint_min', '480', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      '-movflags', '+faststart', fixturePath]);
  }
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', fixturePath]));
  validateFixtureProbe(probe);
  const manifest = { version: 1, codec: 'h264', width: 3840, height: 2160, fps: 60,
    durationUs: 20_000_000, gopFrames: 480, pixelFormat: 'yuv420p',
    bytes: fs.statSync(fixturePath).size,
    sha256: createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex') };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
