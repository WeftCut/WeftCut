// PROTOTYPE runner: all Python dependencies stay in the ignored scratch venv.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const scratch = path.join(root, '.scratch/embeddinggemma-poc');
const venv = path.join(scratch, 'venv');
const python = process.env.WEFTCUT_EMBEDDING_PYTHON ?? path.join(venv,
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
mkdirSync(scratch, { recursive: true });

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited (${code})`)));
  });
}

try {
  if (process.argv[2] === 'setup' || !existsSync(python)) {
    if (!existsSync(python)) {
      // Prefer the system Python over a shell's unrelated Conda environment.
      const bootstrap = process.env.WEFTCUT_POC_BOOTSTRAP_PYTHON ?? (existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');
      await run(bootstrap, ['-m', 'venv', venv]);
    }
    const pip = ['-m', 'pip', 'install', '--cache-dir', path.join(scratch, 'pip-cache')];
    // CUDA setup is explicit; normal launches reuse the installed runtime.
    const accelerator = process.argv.includes('--cuda') ? 'cu130' : 'cpu';
    await run(python, [...pip, `torch==2.14.1+${accelerator}`, `torchvision==0.29.1+${accelerator}`,
      '--index-url', `https://download.pytorch.org/whl/${accelerator}`]);
    await run(python, [...pip, '-r', path.join(here, 'requirements.txt')]);
  }
  await run(python, ['-c', 'import torch, torchvision, transformers, sentence_transformers, PIL; print("EmbeddingGemma POC runtime ready:", torch.__version__, "CUDA:", torch.cuda.is_available())']);
  if (process.argv[2] !== 'setup') {
    await run('npm', ['run', 'dev'], { ...process.env, VITE_WEFTCUT_EMBEDDING_POC: '1', WEFTCUT_EMBEDDING_PYTHON: python });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
