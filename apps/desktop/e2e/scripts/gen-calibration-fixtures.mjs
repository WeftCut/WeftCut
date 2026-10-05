// A separate, shorter calibration set. Never shorten the shared 60s fixtures:
// decode conformance tests seek into their tail. Copy compressed packets so the
// workload in the retained interval is identical, rather than easier to decode.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BENCH_MATRIX, BENCH_MEDIA_DIR, benchFixturePath } from './gen-decode-bench-fixtures.mjs';

export const CALIBRATION_SECONDS = 20;
export const CALIBRATION_DIR = path.join(BENCH_MEDIA_DIR, 'calibration-20s');
export const CALIBRATION_NAMES = ['h264-1080', 'h264-2160', 'hevc-1080', 'hevc-2160'];
export const calibrationFixturePath = name => {
  if (!CALIBRATION_NAMES.includes(name)) throw new Error(`Unknown calibration fixture ${name}`);
  return path.join(CALIBRATION_DIR, `${name}.mp4`);
};

const here = path.dirname(fileURLToPath(import.meta.url));
const binary = name => {
  if (process.env[name.toUpperCase()]) return process.env[name.toUpperCase()];
  const bundled = path.resolve(here, '../../resources/ffmpeg/win', `${name}.exe`);
  return process.platform === 'win32' && fs.existsSync(bundled) ? bundled : name;
};
function run(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  if (r.error || r.status !== 0) throw new Error(`${command}: ${r.error ?? r.stderr}`);
  return r.stdout;
}
function probe(file) {
  return JSON.parse(run(binary('ffprobe'), ['-v', 'error', '-select_streams', 'v:0',
    '-show_streams', '-show_format', '-show_packets', '-show_data_hash', 'sha256',
    '-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate:format=duration:packet=pts_time,flags,data_hash',
    '-of', 'json', file]));
}
export function validateShortFixture(row, source, short) {
  const stream = short.streams?.[0];
  for (const [key, expected] of Object.entries({ codec_name: row.codec, width: row.width, height: row.height, pix_fmt: row.pixFmt, r_frame_rate: '30/1' })) {
    if (stream?.[key] !== expected) throw new Error(`${row.name}: unexpected ${key}: ${stream?.[key]}`);
  }
  const durationS = Number(short.format?.duration);
  if (!(durationS >= 20 && durationS <= 20.2)) throw new Error(`${row.name}: unexpected duration ${durationS}`);
  const packets = short.packets ?? [];
  if (packets.length < 600) throw new Error(`${row.name}: missing frames`);
  for (let i = 0; i < packets.length; i++) {
    const a = source.packets?.[i], b = packets[i];
    if (!a?.data_hash || a.data_hash !== b.data_hash || Math.abs(Number(a.pts_time) - Number(b.pts_time)) > .001) {
      throw new Error(`${row.name}: compressed packet ${i} differs from the original`);
    }
  }
  const keyframes = packets.filter(p => p.flags.includes('K')).map(p => Number(p.pts_time));
  if (![0, 8, 16].every(t => keyframes.some(k => Math.abs(k - t) < .001))) {
    throw new Error(`${row.name}: expected keyframes at 0, 8, 16 seconds`);
  }
  return { durationUs: Math.round(durationS * 1e6), packets: packets.length, keyframes, packetPrefixIdentical: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(CALIBRATION_DIR, { recursive: true });
  const manifest = { version: 1, recipe: 'first 20s, video stream copy, original 30fps / 8s GOP', fixtures: [] };
  for (const name of CALIBRATION_NAMES) {
    const row = BENCH_MATRIX.find(r => r.name === name);
    const source = benchFixturePath(name), file = calibrationFixturePath(name);
    if (!fs.existsSync(source)) throw new Error(`Generate the source first: gen-decode-bench-fixtures.mjs --only ${name}`);
    if (!fs.existsSync(file) || process.argv.includes('--force')) {
      run(binary('ffmpeg'), ['-v', 'error', '-y', '-i', source, '-t', String(CALIBRATION_SECONDS), '-map', '0:v:0', '-an', '-c:v', 'copy', '-movflags', '+faststart', file]);
    }
    const validation = validateShortFixture(row, probe(source), probe(file));
    const entry = { name, file, source, bytes: fs.statSync(file).size, sourceBytes: fs.statSync(source).size, ...validation };
    manifest.fixtures.push(entry);
    console.log(`${name}: ${(entry.bytes/2**20).toFixed(1)} MiB / ${(entry.durationUs/1e6).toFixed(3)}s; packets identical, keyframes ${entry.keyframes.join(', ')}`);
  }
  fs.writeFileSync(path.join(CALIBRATION_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
