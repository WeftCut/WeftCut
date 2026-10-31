import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExportEncoderLoad } from '../shared/exportJob';

const exec = promisify(execFile);
const SOFTWARE = new Set(['libx264', 'libx265', 'libvpx-vp9', 'libsvtav1', 'libaom-av1', 'prores_ks', 'dnxhd']);

/** Match this export's exact output, not a concurrent proxy, probe or decoder. */
export function encoderForExport(argv: string[], output: string): Omit<ExportEncoderLoad, 'utilization_percent'> | null {
  if (!/[/\\]ffmpeg(?:\.native)?$/.test(argv[0] ?? '') || argv.at(-1) !== output) return null;
  const codec = argv[argv.indexOf('-c:v') + 1];
  if (!argv.includes('-c:v') || !codec) return null;
  if (/_nvenc$/.test(codec)) return { encoder: codec, device: 'gpu' };
  if (SOFTWARE.has(codec)) return { encoder: codec, device: 'cpu' };
  return null; // An unsupported/opaque encoder is not proof of CPU fallback.
}

export function nvidiaEncoderLoad(text: string): number | null {
  const lines = text.trim().split(/\r?\n/);
  // Without an explicit runtime-to-physical mapping, multiple visible GPUs
  // cannot safely be attributed to this encoder. Unknown is preferable to a
  // plausible but wrong percentage from another card.
  if (lines.length !== 1) return null;
  const value = lines[0]?.trim();
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const percent = Number(value);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

function cpuTimes() {
  return os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
}

/** On-demand, capped at one scan every 3s by ExportJobs. No process signalling,
 * permanent polling, driver probes, or synchronous subprocesses. Linux server
 * only; absence of telemetry stays unknown, never a fabricated zero. */
export function createExportTelemetry() {
  let previousCpu = cpuTimes();
  return async (output: string): Promise<ExportEncoderLoad | null> => {
    if (process.platform !== 'linux') return null;
    const currentCpu = cpuTimes();
    const total = currentCpu.total - previousCpu.total;
    const cpuPercent = total > 0 ? Math.max(0, Math.min(100,
      100 * (1 - (currentCpu.idle - previousCpu.idle) / total))) : null;
    previousCpu = currentCpu;
    const entries = await fs.readdir('/proc');
    let found: ReturnType<typeof encoderForExport> = null;
    // Do not launch a child command per process or read environ/other secrets.
    for (const pid of entries) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const argv = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
        found = encoderForExport(argv, output);
        if (found) break;
      } catch { /* Processes may exit during this read-only sample. */ }
    }
    if (!found) return null;
    if (found.device === 'cpu') return { ...found, utilization_percent: cpuPercent };
    try {
      // Container visibility is the device namespace used by FFmpeg. Its
      // default NVENC device is the first assigned GPU, not a panel GPU index.
      const { stdout } = await exec('nvidia-smi', ['--query-gpu=utilization.encoder', '--format=csv,noheader,nounits'],
        { timeout: 2_000, maxBuffer: 16_384 });
      return { ...found, utilization_percent: nvidiaEncoderLoad(stdout) };
    } catch { return { ...found, utilization_percent: null }; }
  };
}
