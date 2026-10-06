import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CALIBRATION_FIXTURE_RECIPE, calibrationFixtureArgs, validateFixtureProbe,
  type CalibrationFixture } from '../shared/calibration-fixture';

type RunTool = (binary: string, args: string[], signal: AbortSignal) => Promise<string>;
export interface CalibrationTools { ffmpeg: string; ffprobe: string }

/** Resolves only after process teardown, including cancellation and spawn errors. */
const runTool: RunTool = (binary, args, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const child = spawn(binary, args, { signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', error: Error | null = null;
  const timer = setTimeout(() => { error = new Error('Test media preparation timed out'); child.kill(); }, 600_000);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-2_000_000); });
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16_000); });
  child.once('error', reason => { error = reason; });
  child.once('close', code => {
    clearTimeout(timer);
    if (error || code !== 0) reject(error ?? new Error(`Test media preparation failed (${code}): ${stderr}`));
    else resolve(stdout);
  });
});

async function hashFile(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  signal.throwIfAborted();
  return hash.digest('hex');
}

/** Generate lazily, validate before publishing, and reuse only matching bytes/tools/recipe. */
export async function ensureCalibrationFixture(directory: string, tools: CalibrationTools,
  signal: AbortSignal, run: RunTool = runTool): Promise<CalibrationFixture> {
  signal.throwIfAborted();
  const toolHash = await hashFile(tools.ffmpeg, signal);
  const fixturePath = path.join(directory, 'h264-4k60.mp4');
  const manifestPath = path.join(directory, 'manifest.json');
  try {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    const recipe = CALIBRATION_FIXTURE_RECIPE;
    if (manifest.toolHash === toolHash && Object.entries(recipe).every(([key, value]) => manifest[key] === value)
      && manifest.bytes === (await fsp.stat(fixturePath)).size
      && manifest.sha256 === await hashFile(fixturePath, signal)) {
      return { ...manifest, path: fixturePath };
    }
  } catch { signal.throwIfAborted(); /* Missing or invalid cache: regenerate. */ }
  await fsp.mkdir(directory, { recursive: true });
  const staging = await fsp.mkdtemp(path.join(directory, '.prepare-'));
  try {
    const media = path.join(staging, 'h264-4k60.mp4');
    await run(tools.ffmpeg, calibrationFixtureArgs(media), signal);
    signal.throwIfAborted();
    const probe = JSON.parse(await run(tools.ffprobe,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', media], signal));
    validateFixtureProbe(probe);
    const manifest = { ...CALIBRATION_FIXTURE_RECIPE, toolHash,
      bytes: (await fsp.stat(media)).size, sha256: await hashFile(media, signal) };
    const pendingManifest = path.join(staging, 'manifest.json');
    await fsp.writeFile(pendingManifest, JSON.stringify(manifest));
    signal.throwIfAborted();
    // A crash between the two renames leaves a mismatched pair, regenerated next run.
    await fsp.rename(media, fixturePath);
    await fsp.rename(pendingManifest, manifestPath);
    return { ...manifest, path: fixturePath };
  } finally { await fsp.rm(staging, { recursive: true, force: true }); }
}
