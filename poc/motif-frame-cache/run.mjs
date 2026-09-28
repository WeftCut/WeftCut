import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (args.includes('--gpu')) env.MOTIF_BENCH_GPU = '1';
if (args.includes('--fixed')) env.MOTIF_OSR_FIXED_SIZE = '1';
const input = args.indexOf('--png');
if (input >= 0) env.MOTIF_BENCH_PNG = path.resolve(args[input + 1]);
const entry = args.includes('--osr') ? 'osr.cjs' : 'bench.cjs';
const electron = createRequire(import.meta.url)('electron');
const result = spawnSync(electron, [path.join(root, 'poc/motif-frame-cache', entry)], {
  cwd: root, env, stdio: 'inherit', windowsHide: true,
});
process.exit(result.status ?? 1);
