// PROTOTYPE: standalone native inference; provision pinned SDK/model if absent.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setupLiteRt } from './setup-litert.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const scratch = path.join(root, '.scratch/embeddinggemma-poc');
const native = path.join(scratch, 'litert');
const frames = path.join(native, 'frames');
const backend = process.argv[2] ?? 'gpu';
const tokens = process.argv[3] ?? '140';
const fp16 = process.argv.includes('--fp16');
const caseName = `${backend}-${tokens}${fp16 ? '-fp16' : ''}`;
if (!['cpu', 'gpu'].includes(backend) || !['70', '140'].includes(tokens)) throw new Error('Use cpu|gpu and 70|140');
await setupLiteRt(native);
fs.mkdirSync(frames, { recursive: true });
const start = performance.now();
for (const name of fs.readdirSync(path.join(scratch, 'test-videos')).filter(n => n.endsWith('.mp4')).sort()) {
  execFileSync(path.join(root, 'apps/desktop/resources/ffmpeg/linux/ffmpeg'), [
    '-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '2', '-copyts',
    '-i', path.join(scratch, 'test-videos', name), '-map', '0:v:0', '-an', '-sn',
    '-vf', "setpts=PTS,fps=1:start_time=0:round=up:eof_action=pass,scale=w='min(768,iw)':h='min(768,ih)':force_original_aspect_ratio=decrease,setsar=1",
    '-threads', '1', '-fps_mode', 'passthrough', '-start_number', '0', path.join(frames, name.replace('.mp4', '--%03d.png')),
  ], { stdio: 'inherit' });
}
const preparation = { frames: fs.readdirSync(frames).filter(n => n.endsWith('.png')).length, decodeSeconds: (performance.now() - start) / 1000 };
fs.writeFileSync(path.join(native, 'frame-preparation.json'), JSON.stringify(preparation, null, 2));
execFileSync('g++', ['-O3', '-std=c++17', '-I', path.join(native, 'include'), path.join(here, 'litert-bench.cpp'),
  '-L', path.join(native, 'sdk/litert_lm'), '-l:liblitert-lm.so', '-Wl,-rpath,$ORIGIN/sdk/litert_lm', '-o', path.join(native, 'litert-bench')], { stdio: 'inherit' });
const cache = path.join(native, `cache-${caseName}`);
fs.mkdirSync(cache, { recursive: true });
const log = path.join(native, `${caseName}.stderr.log`);
const stderr = fs.openSync(log, 'w');
console.log(`Running native LiteRT-LM ${backend}, ${tokens} vision tokens, ${preparation.frames} frames. Native logs: ${log}`);
try {
  const wall = performance.now();
  const stdout = execFileSync(path.join(native, 'litert-bench'), [
    path.join(native, 'embeddinggemma-2-text-vision-440m.litertlm'), backend, tokens, frames, cache,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', stderr], timeout: 900000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...(fp16 ? { WEFTCUT_LITERT_FP16: '1' } : {}) } });
  fs.writeFileSync(path.join(native, `${caseName}.stdout.log`), stdout);
  const resultLine = stdout.split('\n').find(line => line.startsWith('{"backend":'));
  if (!resultLine) throw new Error('Native benchmark did not return a result');
  const result = { ...JSON.parse(resultLine), preparation, processSeconds: (performance.now() - wall) / 1000 };
  fs.writeFileSync(path.join(native, `${caseName}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(fs.readFileSync(log, 'utf8').slice(-10000));
  throw error;
} finally {
  fs.closeSync(stderr);
}
