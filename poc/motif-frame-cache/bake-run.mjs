import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.platform !== 'win32') throw new Error('This GPU readback experiment currently requires Windows.');
const target = path.join(root, 'apps/desktop/native/target');
const env = { ...process.env, RUSTC_WRAPPER: '' };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--quick')) env.MOTIF_BAKE_QUICK = '1';
const build = spawnSync('cargo', ['build', '--offline', '--release', '--locked', '--manifest-path',
  path.join(root, 'poc/motif-frame-cache/bake-native/Cargo.toml'), '--target-dir', target],
{ cwd: root, env, stdio: 'inherit', windowsHide: true });
if (build.status !== 0) process.exit(build.status ?? 1);
mkdirSync(path.join(root, '.scratch'), { recursive: true });
copyFileSync(path.join(target, 'release/motif_bake_bench.dll'), path.join(root, '.scratch/motif-bake-addon.node'));
const electron = createRequire(import.meta.url)('electron');
const run = spawnSync(electron, [path.join(root, 'poc/motif-frame-cache/bake.cjs')],
  { cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 15 * 60 * 1000 });
if (run.error) console.error(run.error);
process.exit(run.status ?? 1);
