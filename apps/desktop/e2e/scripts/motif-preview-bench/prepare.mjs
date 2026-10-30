import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import common from './common.cjs';

const { desktop, output } = common;
const options = new Set(process.argv.slice(2));
if (options.has('--help')) {
  console.log('node prepare.mjs [--video] [--decoder] [--all]\nOptional WEFTCUT_BENCH_VIDEO_ENCODER defaults to libx264.');
  process.exit(0);
}
fs.mkdirSync(output, { recursive: true });
const native = createRequire(import.meta.url)(path.join(desktop, 'native/index.js'));

for (const width of [3840, 1920]) {
  const height = width * 9 / 16;
  const directory = path.join(output, `frames-${width}`);
  fs.mkdirSync(directory, { recursive: true });
  for (let frame = 0; frame < 30; frame++) {
    const file = path.join(directory, `${frame}.wfrm`);
    if (fs.existsSync(file)) continue;
    const rgba = Buffer.alloc(width * height * 4);
    const x = Math.floor(frame * width / 40), y = Math.floor(height / 3);
    for (let yy = y; yy < y + Math.floor(height / 5); yy++) {
      for (let xx = x; xx < x + Math.floor(width / 5); xx++) {
        const p = (yy * width + xx) * 4;
        rgba[p] = 220; rgba[p + 1] = 70; rgba[p + 2] = 110; rgba[p + 3] = 128;
      }
    }
    const png = PNG.sync.write({ width, height, data: rgba }, { deflateLevel: 1 });
    const encoded = await native.motifEncodePng(png, true);
    if (encoded.readUInt32LE(16) !== 2) throw new Error('Rebuild the addon: this benchmark requires codec-2 zstd frames.');
    fs.writeFileSync(file, encoded);
  }
}

if (options.has('--video') || options.has('--all')) {
  const file = path.join(output, 'footage-4k.mp4');
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    const platform = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
    const ffmpeg = process.env.FFMPEG || path.join(desktop, 'resources/ffmpeg', platform, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const encoder = process.env.WEFTCUT_BENCH_VIDEO_ENCODER || 'libx264';
    const extra = encoder === 'libx264' ? ['-preset', 'ultrafast', '-threads', '2'] : [];
    const temporary = file.replace(/\.mp4$/, '.partial.mp4');
    execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30000/1001',
      '-t', '61', '-c:v', encoder, ...extra, '-b:v', '4M', '-pix_fmt', 'yuv420p', '-an', '-y', temporary], { stdio: 'inherit' });
    fs.renameSync(temporary, file);
  }
}

if (options.has('--decoder') || options.has('--all')) {
  const directory = path.join(output, 'decoder');
  if (!fs.existsSync(path.join(directory, 'node_modules/fzstd/esm/index.mjs'))) {
    fs.mkdirSync(directory, { recursive: true });
    // Isolated dependency, never a change to the application's package files.
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', directory,
      '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', 'fzstd@0.1.1'], { stdio: 'inherit' });
  }
}
console.log('Synthetic frames prepared in the ignored benchmark output directory.');
