import { spawn } from 'node:child_process';

export function av1ProbeArguments(backend: 'av1_nvenc' | 'av1_vaapi', bitDepth: 8 | 10, device: string | null): string[] {
  if (backend === 'av1_vaapi' && !/^\/dev\/dri\/renderD[0-9]+$/.test(device ?? '')) throw new Error('no accessible render device');
  const source = 'color=c=black:s=640x360:d=0.1:r=30' + (bitDepth === 10 ? ',format=yuv420p10le' : '');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1'];
  if (backend === 'av1_vaapi') args.push('-vaapi_device', device!);
  args.push('-f', 'lavfi', '-i', source, '-vf', 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv' +
    (backend === 'av1_vaapi' ? `,format=${bitDepth === 10 ? 'p010le' : 'nv12'},hwupload` : ''), '-c:v', backend, '-b:v', '2000000');
  if (backend === 'av1_nvenc') args.push('-pix_fmt', bitDepth === 10 ? 'p010le' : 'nv12');
  return [...args, '-threads', '1', '-frames:v', '1', '-f', 'null', '-'];
}

export async function probeAv1Encoder(binary: string, backend: 'av1_nvenc' | 'av1_vaapi', bitDepth: 8 | 10, device: string | null): Promise<void> {
  const args = av1ProbeArguments(backend, bitDepth, device);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let detail = '', failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('AV1 encoder diagnostic timeout'); child.kill('SIGKILL'); }, 8000);
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { detail = (detail + chunk).slice(-1024); });
    child.once('error', error => { failure = error; });
    child.once('close', code => { clearTimeout(timer); if (failure || code !== 0) reject(failure ?? new Error(detail)); else resolve(); });
  });
}
