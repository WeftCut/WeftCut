// Maintainer-only rebuild. Normal template/app builds use the checked-in pair.
// Requires Docker and network; source and compiler version are pinned.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const sourceCommit = 'b76a431c6a39c07fe8bb2edf1cbf44781150ed6b'; // v1_50_0_2
const image = 'emscripten/emsdk@sha256:8847dad4171ebc8a53d9ae5cda86a2546ef5b2e68834c14dc1ba2b2962e125cc'; // 3.1.64
const desktop = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(desktop, 'out', 'basis-source', sourceCommit);
const output = path.join(desktop, 'motif-templates', 'three-model', 'basis');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(output, { recursive: true });
async function fetchChecked(url) {
  const result = await fetch(url);
  if (!result.ok) throw new Error(`${result.status}: ${url}`);
  return result;
}
const tree = await (await fetchChecked(`https://api.github.com/repos/BinomialLLC/basis_universal/git/trees/${sourceCommit}?recursive=1`)).json();
const entries = tree.tree.filter(entry => entry.type === 'blob' && (
  entry.path.startsWith('transcoder/') || entry.path.startsWith('zstd/') ||
  entry.path === 'webgl/transcoder/basis_wrappers.cpp' || entry.path === 'LICENSE'));
for (const entry of entries) {
  const target = path.join(source, entry.path);
  const data = fs.existsSync(target) ? fs.readFileSync(target) :
    Buffer.from(await (await fetchChecked(`https://raw.githubusercontent.com/BinomialLLC/basis_universal/${sourceCommit}/${entry.path}`)).arrayBuffer());
  const gitHash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  if (gitHash !== entry.sha) throw new Error(`Source integrity failed: ${entry.path}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}
const flags = [
  '/src/transcoder/basisu_transcoder.cpp', '/src/webgl/transcoder/basis_wrappers.cpp', '/src/zstd/zstddeclib.c',
  '-I/src/transcoder', '-std=c++11', '-O3', '-fno-strict-aliasing', '--bind',
  ...['NDEBUG', 'BASISD_SUPPORT_UASTC_HDR=1', 'BASISD_SUPPORT_UASTC=1', 'BASISD_SUPPORT_BC7=1',
    'BASISD_SUPPORT_ATC=0', 'BASISD_SUPPORT_ASTC_HIGHER_OPAQUE_QUALITY=0', 'BASISD_SUPPORT_PVRTC2=0',
    'BASISD_SUPPORT_FXT1=0', 'BASISD_SUPPORT_ETC2_EAC_RG11=0', 'BASISU_SUPPORT_ENCODING=0',
    'BASISD_ENABLE_DEBUG_FLAGS=1', 'BASISD_SUPPORT_KTX2=1', 'BASISD_SUPPORT_KTX2_ZSTD=1'].map(flag => '-D' + flag),
  '-sALLOW_MEMORY_GROWTH=1', '-sASSERTIONS=0', '-sMALLOC=emmalloc', '-sMODULARIZE=1', '-sEXPORT_NAME=BASIS',
  '-sDYNAMIC_EXECUTION=0', '-sEXPORTED_RUNTIME_METHODS=HEAP8', '-sENVIRONMENT=web,worker',
  '-o', '/output/basis_transcoder.js',
];
const result = spawnSync('docker', ['run', '--rm',
  '--mount', `type=bind,source=${source},target=/src,readonly`,
  '--mount', `type=bind,source=${output},target=/output`, image, 'em++', ...flags], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) throw new Error('Basis build failed: ' + (result.error ?? result.status));
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'LICENSE.txt'));
const hashes = Object.fromEntries(['basis_transcoder.js', 'basis_transcoder.wasm'].map(name =>
  [name, createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex')]));
const imageInfo = spawnSync('docker', ['image', 'inspect', image, '--format', '{{index .RepoDigests 0}}'], { encoding: 'utf8', windowsHide: true });
fs.writeFileSync(path.join(output, 'BUILD.json'), JSON.stringify({ sourceCommit, image: imageInfo.stdout?.trim() || image, flags, sha256: hashes }, null, 2) + '\n');
console.log('Built CSP-compatible Basis transcoder:', hashes);
