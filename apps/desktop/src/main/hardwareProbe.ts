import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadNativeDecode } from './native-decode';
import { hwEligibleOnLane } from '../shared/hwLaneEligibility';
import { untestedAcceleration, type CodecHardwareProbe, type HardwareAccelerationDiagnostics, type HardwareDevice, type HardwareFailure } from '../shared/hardware-diagnostics';

export interface HardwareProbeRequest { directory: string; ffmpeg: string; devices: HardwareDevice[] }
export function probeFailure(detail: string): HardwareFailure {
  if (/tim(?:e|ed)\s*out|timeout/i.test(detail)) return 'timeout';
  if (/permission|not permitted|access denied/i.test(detail)) return 'permission-denied';
  if (/not built|not loaded|component|missing.*addon/i.test(detail)) return 'component-unavailable';
  if (/cannot load|failed to load|driver.*not|no.*device/i.test(detail)) return 'driver-unavailable';
  return 'probe-failed';
}
async function makeFixture(binary: string, codec: CodecHardwareProbe['codec'], output: string): Promise<void> {
  const encoder = { h264: 'libx264', hevc: 'libx265', vp9: 'libvpx-vp9' }[codec];
  const tuning = codec === 'hevc' ? ['-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1']
    : codec === 'h264' ? ['-preset', 'ultrafast'] : ['-deadline', 'realtime', '-cpu-used', '8'];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['-y', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-frames:v', '3', '-an', '-c:v', encoder,
      '-threads', '1', '-pix_fmt', 'yuv420p', ...tuning, output], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let detail = '', error: Error | null = null;
    const timer = setTimeout(() => { error = new Error('Fixture preparation timed out'); child.kill('SIGKILL'); }, 10_000);
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { detail = (detail + chunk).slice(-2048); });
    child.once('error', reason => { error = reason; });
    child.once('close', code => { clearTimeout(timer); if (error || code !== 0) reject(error ?? new Error(detail)); else resolve(); });
  });
}

/** Runs only inside the killable utility process; never blocks the editor's main thread. */
export async function runHardwareProbe(request: HardwareProbeRequest,
  publish: (result: HardwareAccelerationDiagnostics) => void): Promise<HardwareAccelerationDiagnostics> {
  const result = { ...untestedAcceleration(), status: 'running' as HardwareAccelerationDiagnostics['status'], sampled_at: Date.now() };
  await fs.mkdir(request.directory, { recursive: true });
  const native = loadNativeDecode();
  const devices = request.devices;
  const nvidia = devices.filter(d => d.vendor_id === 0x10de);
  const lanes = native.lanes.filter(l => l === 'nvdec' || l === 'vaapi');
  for (const codec of ['h264', 'hevc', 'vp9'] as const) {
    const file = path.join(request.directory, `${codec}.${codec === 'vp9' ? 'webm' : 'mp4'}`);
    let fixtureError: string | null = null;
    if (native.backend && lanes.length) {
      try { await makeFixture(request.ffmpeg, codec, file); } catch (error) { fixtureError = String(error).slice(0, 512); }
    }
    for (const lane of lanes.length ? lanes : ['standard']) {
      if (!hwEligibleOnLane(lane, codec, 'yuv420p') && lane !== 'standard') continue;
      const targets = lane === 'vaapi' ? devices.flatMap(d => d.render_nodes.map(node => ({ id: d.id, path: node })))
        : [{ id: nvidia.length === 1 ? nvidia[0].id : null, path: null }];
      for (const target of targets.length ? targets : [{ id: null, path: null }]) {
        let ok = false, detail: string | undefined;
        if (!native.backend) detail = native.reason ?? 'component unavailable';
        else if (lane === 'standard') detail = 'hardware lane not built';
        else if (fixtureError) detail = fixtureError;
        else if (lane === 'vaapi' && !target.path) detail = 'no render device';
        else {
          const verdict = native.backend.previewHwProbe(file, lane, target.path, 5000);
          ok = verdict.ok; detail = verdict.reason;
        }
        result.decode.push({ codec, bit_depth: 8, backend: lane, device_id: target.id, device_path: target.path,
          status: ok ? 'available' : 'unavailable', reason: ok ? null : probeFailure(detail ?? ''), ...(detail ? { detail } : {}) });
        publish({ ...result });
      }
    }
  }
  const core = createRequire(import.meta.url)('@weftcut/core') as {
    hardwareEncoderDiagnostics?: () => Promise<string>;
  };
  if (core.hardwareEncoderDiagnostics) {
    const encoders = JSON.parse(await core.hardwareEncoderDiagnostics()) as { codec: CodecHardwareProbe['codec']; bit_depth: 8 | 10; backend: string; ok: boolean; reason: string | null }[];
    result.encode = encoders.map(row => ({ codec: row.codec, bit_depth: row.bit_depth, backend: row.backend,
      device_id: row.backend.endsWith('_nvenc') && nvidia.length === 1 ? nvidia[0].id : null, device_path: null,
      status: row.ok ? 'available' : 'unavailable', reason: row.ok ? null : probeFailure(row.reason ?? ''),
      ...(row.reason ? { detail: row.reason.slice(0, 512) } : {}) }));
  } else result.encode = [{ codec: 'h264', bit_depth: 8, backend: 'ffmpeg', device_id: null, device_path: null,
    status: 'not-tested', reason: 'component-unavailable' }];
  return { ...result, status: 'complete', sampled_at: Date.now() };
}
