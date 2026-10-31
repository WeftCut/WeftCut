import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadNativeDecode } from './native-decode';
import { hwEligibleOnLane } from '../shared/hwLaneEligibility';
import { diagnosticFixture, hardwareDecodeProfiles } from '../shared/hardwareCodecProfiles';
import { probeHardwareFrames } from './hardwareFrameProbe';
import { probeAv1Encoder } from './hardwareEncoderProbe';
import { untestedAcceleration, type CodecHardwareProbe, type HardwareAccelerationDiagnostics, type HardwareDevice, type HardwareFailure } from '../shared/hardware-diagnostics';

export interface HardwareProbeRequest { directory: string; ffmpeg: string; devices: HardwareDevice[] }
export function probeFailure(detail: string): HardwareFailure {
  if (/tim(?:e|ed)\s*out|timeout/i.test(detail)) return 'timeout';
  if (/permission|not permitted|access denied/i.test(detail)) return 'permission-denied';
  if (/not built|not loaded|component|missing.*addon/i.test(detail)) return 'component-unavailable';
  if (/cannot load|failed to load|driver.*not|no.*device/i.test(detail)) return 'driver-unavailable';
  return 'probe-failed';
}
async function makeFixture(binary: string, codec: CodecHardwareProbe['codec'], bitDepth: 8 | 10, output: string): Promise<void> {
  const { encoder, tuning, pixFmt } = diagnosticFixture(codec, bitDepth);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['-y', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-frames:v', '30', '-an', '-c:v', encoder,
      '-threads', '1', '-pix_fmt', pixFmt, ...tuning, output], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
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
  // Utility hosts must resolve the same bundled FFmpeg as the editor. The
  // native encoder probe resolves through PATH independently of makeFixture.
  process.env.PATH = path.dirname(request.ffmpeg) + path.delimiter + (process.env.PATH ?? '');
  const native = loadNativeDecode(() => {});
  const devices = request.devices;
  const nvidia = devices.filter(d => d.vendor_id === 0x10de);
  const lanes = native.lanes.filter(l => l === 'nvdec' || l === 'vaapi');
  for (const { codec, bitDepth } of hardwareDecodeProfiles) {
    const fixture = diagnosticFixture(codec, bitDepth);
    const file = path.join(request.directory, fixture.filename);
    let fixtureError: string | null = null;
    if (native.backend && lanes.length) {
      try { await makeFixture(request.ffmpeg, codec, bitDepth, file); } catch (error) { fixtureError = String(error).slice(0, 512); }
    }
    for (const lane of lanes.length ? lanes : ['standard']) {
      if (!hwEligibleOnLane(lane, codec, fixture.pixFmt) && lane !== 'standard') continue;
      const targets = lane === 'vaapi' ? devices.filter(d => d.vendor_id !== 0x10de).flatMap(d => d.render_nodes.map(node => ({ id: d.id, path: node })))
        : [{ id: nvidia.length === 1 ? nvidia[0].id : null, path: null }];
      for (const target of targets.length ? targets : [{ id: null, path: null }]) {
        let ok = false, detail: string | undefined;
        if (!native.backend) detail = native.reason ?? 'component unavailable';
        else if (lane === 'standard') detail = 'hardware lane not built';
        else if (fixtureError) detail = fixtureError;
        else if (lane === 'vaapi' && !target.path) detail = 'no render device';
        else {
          try {
            if (lane === 'vaapi' && target.path) await fs.access(target.path, constants.R_OK | constants.W_OK);
            const verdict = native.backend.previewHwProbe(file, lane, target.path, 5000);
            ok = verdict.ok; detail = verdict.reason;
            if (ok) await probeHardwareFrames(native.backend, file, lane, target.path, bitDepth);
          } catch (error) { ok = false; detail = String(error); }
        }
        result.decode.push({ codec, bit_depth: bitDepth, backend: lane, device_id: target.id, device_path: target.path,
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
      device_id: row.backend.endsWith('_nvenc') && nvidia.length === 1 ? nvidia[0].id
        : row.backend.endsWith('_vaapi') ? devices.find(d => d.render_nodes.includes(process.env.WEFTCUT_VAAPI_DEVICE ?? ''))?.id ?? null : null,
      device_path: row.backend.endsWith('_vaapi') ? process.env.WEFTCUT_VAAPI_DEVICE ?? null : null,
      status: row.ok ? 'available' : 'unavailable', reason: row.ok ? null : probeFailure(row.reason ?? ''),
      ...(row.reason ? { detail: row.reason.slice(0, 512) } : {}) }));
  } else result.encode = [{ codec: 'h264', bit_depth: 8, backend: 'ffmpeg', device_id: null, device_path: null,
    status: 'not-tested', reason: 'component-unavailable' }];
  // The release native ABI diagnostics predate AV1, although its actual export
  // registry already has AV1 adapters. Probe real FFmpeg encoders, not names or
  // CPU model promises. Future native diagnostics owning AV1 supersede this.
  if (!result.encode.some(row => row.codec === 'av1')) {
    for (const bitDepth of [8, 10] as const) {
      const targets = [
        ...(nvidia.length === 1 ? [{ backend: 'av1_nvenc' as const, id: nvidia[0]!.id, path: null }] : []),
        ...devices.filter(d => d.vendor_id !== 0x10de).flatMap(d => d.render_nodes.map(node => ({ backend: 'av1_vaapi' as const, id: d.id, path: node }))),
      ];
      for (const target of targets) {
        let detail: string | undefined;
        try { await probeAv1Encoder(request.ffmpeg, target.backend, bitDepth, target.path); }
        catch (error) { detail = String(error).slice(0, 1024); }
        result.encode.push({ codec: 'av1', bit_depth: bitDepth, backend: target.backend, device_id: target.id, device_path: target.path,
          status: detail ? 'unavailable' : 'available', reason: detail ? probeFailure(detail) : null, ...(detail ? { detail } : {}) });
        publish({ ...result });
      }
    }
  }
  return { ...result, status: 'complete', sampled_at: Date.now() };
}
