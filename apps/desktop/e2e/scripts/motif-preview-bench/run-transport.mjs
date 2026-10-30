import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { electronBinPath } from '../../lib/electron-bin.mjs';
import common from './common.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!fs.existsSync(path.join(common.output, 'frames-3840/29.wfrm')) ||
    !fs.existsSync(path.join(common.output, 'decoder/node_modules/fzstd/esm/index.mjs'))) {
  throw new Error('Run prepare.mjs --decoder before the transport benchmark.');
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBinPath(), [path.join(here, 'transport-main.cjs')], { env, stdio: 'inherit' });
const watchdog = setTimeout(() => child.kill('SIGTERM'), 180_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', error => { clearTimeout(watchdog); console.error(common.sanitize(String(error))); process.exitCode = 1; });
child.once('exit', code => { clearTimeout(watchdog); process.exitCode = code ?? 1; });
