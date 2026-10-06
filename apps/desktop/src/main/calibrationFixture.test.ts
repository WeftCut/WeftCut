import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCalibrationFixture } from './calibrationFixture';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-fixture-test-'));
  directories.push(root);
  const directory = path.join(root, 'cache');
  const tools = { ffmpeg: path.join(root, 'ffmpeg'), ffprobe: path.join(root, 'ffprobe') };
  fs.writeFileSync(tools.ffmpeg, 'controlled binary');
  const signal = new AbortController().signal;
  const run = vi.fn(async (binary: string, args: string[], _signal: AbortSignal) => {
    if (binary === tools.ffmpeg) { fs.writeFileSync(args.at(-1)!, 'reference video'); return ''; }
    return JSON.stringify({ streams: [{ codec_name: 'h264', width: 3840, height: 2160,
      pix_fmt: 'yuv420p', avg_frame_rate: '60/1', nb_frames: '1200' }], format: { duration: '20' } });
  });
  return { directory, tools, signal, run, ensure: () => ensureCalibrationFixture(directory, tools, signal, run) };
}

it('generates on first use and reuses the validated reference without invoking tools again', async () => {
  const { ensure, run } = setup();
  const fixture = await ensure();
  expect(fixture).toMatchObject({ width: 3840, height: 2160, fps: 60, durationUs: 20_000_000, bytes: 15 });
  expect(fs.readFileSync(fixture.path, 'utf8')).toBe('reference video');
  expect(await ensure()).toEqual(fixture);
  expect(run).toHaveBeenCalledTimes(2);
});

it.each(['media', 'recipe', 'tool'])('regenerates when cached %s changes', async kind => {
  const { ensure, run, directory, tools } = setup();
  const fixture = await ensure();
  if (kind === 'media') fs.writeFileSync(fixture.path, 'corrupted video');
  else if (kind === 'tool') fs.writeFileSync(tools.ffmpeg, 'updated binary');
  else {
    const file = path.join(directory, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), version: 0 }));
  }
  await ensure();
  expect(run).toHaveBeenCalledTimes(4);
  expect(fs.readFileSync(fixture.path, 'utf8')).toBe('reference video');
});

it('rejects invalid generated media and removes partial files without publishing a cache', async () => {
  const { ensure, run, directory } = setup();
  run.mockResolvedValueOnce('').mockResolvedValueOnce(JSON.stringify({ streams: [{ avg_frame_rate: '30/1' }] }));
  await expect(ensure()).rejects.toThrow('Invalid calibration fixture');
  expect(fs.readdirSync(directory)).toEqual([]);
});

it('removes interrupted encoding output and allows a clean retry', async () => {
  const { tools, directory, run, ensure } = setup();
  const controller = new AbortController();
  run.mockImplementationOnce(async (_binary, args, signal) => {
    fs.writeFileSync(args.at(-1)!, 'partial');
    controller.abort();
    signal.throwIfAborted();
    return '';
  });
  await expect(ensureCalibrationFixture(directory, tools, controller.signal, run)).rejects.toThrow();
  expect(fs.readdirSync(directory)).toEqual([]);
  expect((await ensure()).bytes).toBe(15);
});
