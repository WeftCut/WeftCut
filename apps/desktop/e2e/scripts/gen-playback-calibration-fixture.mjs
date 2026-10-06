// Genuine 60 fps input for the controlled playback calibration host.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CALIBRATION_FIXTURE_RECIPE, calibrationFixtureArgs, validateFixtureProbe } from '../../src/shared/calibration-fixture.ts';
export { validateFixtureProbe };

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
    run('ffmpeg', calibrationFixtureArgs(fixturePath));
  }
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', fixturePath]));
  validateFixtureProbe(probe);
  const manifest = { ...CALIBRATION_FIXTURE_RECIPE,
    bytes: fs.statSync(fixturePath).size,
    sha256: createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex') };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
