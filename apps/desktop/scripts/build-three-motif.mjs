import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('..', import.meta.url));
const template = path.join(desktop, 'motif-templates', 'three-model');
const THREE_VERSION = '0.186.1';

function demoModel() {
  const points = [[0, 1, 0], [-1, -1, 1], [1, -1, 1], [0, -1, -1]];
  const faces = [0,1,2, 0,2,3, 0,3,1, 1,3,2];
  const bytes = Buffer.from(new Float32Array(faces.flatMap(i => points[i])).buffer);
  return Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.12, 0.55, 0.95, 1], metallicFactor: 0.1, roughnessFactor: 0.4 } }],
    buffers: [{ byteLength: bytes.length, uri: 'data:application/octet-stream;base64,' + bytes.toString('base64') }],
    bufferViews: [{ buffer: 0, byteLength: bytes.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: faces.length, type: 'VEC3', min: [-1,-1,-1], max: [1,1,1] }],
  }));
}

/** Build a portable offline package. Input resources are copied as a snapshot;
 * the same template builder is exercised by Electron codec integration tests. */
export function buildThreeMotifFiles({ assetsDir, model = assetsDir ? 'model.glb' : 'demo.gltf' } = {}) {
  if (!model || model.split('/').some(p => !p || p === '.' || p === '..') || /[\\:\x00-\x1f]/.test(model)) {
    throw new Error('model must be a relative path inside assetsDir');
  }
  const files = {};
  let total = 0;
  const add = (name, bytes) => {
    total += bytes.length;
    if (total > 256 * 1024 * 1024 || Object.keys(files).length >= 10_000) throw new Error('Motif exceeds package limits');
    files[name] = bytes;
  };
  const copyTree = (root, prefix) => {
    for (const name of fs.readdirSync(root).sort()) {
      const full = path.join(root, name), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('Motif resources must not contain symbolic links: ' + full);
      if (stat.isDirectory()) copyTree(full, prefix + name + '/');
      else if (stat.isFile()) {
        if (stat.size + total > 256 * 1024 * 1024) throw new Error('Motif exceeds package limits');
        add(prefix + name, fs.readFileSync(full));
      } else throw new Error('Not a regular resource: ' + full);
    }
  };
  if (assetsDir) {
    if (fs.lstatSync(assetsDir).isSymbolicLink()) throw new Error('assetsDir must not be a symbolic link');
    copyTree(assetsDir, 'assets/');
  } else add('assets/demo.gltf', demoModel());
  if (!files['assets/' + model]) throw new Error('Model not found in assetsDir: ' + model);
  const threeRoot = path.resolve(path.dirname(require.resolve('three')), '..');
  const version = JSON.parse(fs.readFileSync(path.join(threeRoot, 'package.json'), 'utf8')).version;
  if (version !== THREE_VERSION) throw new Error(`Template expects Three.js ${THREE_VERSION}, installed ${version}; update and validate the template together`);
  for (const name of ['three.module.js', 'three.core.js']) add('vendor/' + name, fs.readFileSync(path.join(threeRoot, 'build', name)));
  for (const name of ['draco_wasm_wrapper.js', 'draco_decoder.wasm']) add('vendor/draco/' + name, fs.readFileSync(path.join(threeRoot, 'examples/jsm/libs/draco/gltf', name)));
  add('vendor/draco/README.md', fs.readFileSync(path.join(threeRoot, 'examples/jsm/libs/draco/README.md')));
  // Both Draco and Basis distribute the unmodified Apache-2.0 license text.
  add('vendor/draco/LICENSE.txt', fs.readFileSync(path.join(template, 'basis/LICENSE.txt')));
  for (const name of ['basis_transcoder.js', 'basis_transcoder.wasm', 'LICENSE.txt', 'BUILD.json']) {
    add('vendor/basis/' + name, fs.readFileSync(path.join(template, 'basis', name)));
  }
  add('vendor/THREE-LICENSE.txt', fs.readFileSync(path.join(threeRoot, 'LICENSE')));
  for (const name of ['index.html', 'scene.js']) add(name, fs.readFileSync(path.join(template, name)));
  // esbuild's external:['three'] also externalizes three/addons/*; only the
  // exact core import belongs in the import map. Bundle addon dependencies.
  const loaderSource = fs.readFileSync(path.join(template, 'model-loader.js'), 'utf8')
    .replace(/'three\/addons\/([^']+)'/g, (_, addon) => JSON.stringify(path.join(threeRoot, 'examples/jsm', addon).replaceAll('\\', '/')));
  const loader = buildSync({ stdin: { contents: loaderSource, resolveDir: template, sourcefile: 'model-loader.js' },
    bundle: true, format: 'esm', external: ['three'], write: false });
  add('vendor/model-loader.js', loader.outputFiles[0].contents);
  add('manifest.json', Buffer.from(JSON.stringify({ name: '3D Model', size: [960, 540], default_duration_s: 5, settle_rafs: 2,
    props_schema: { model: { type: 'string', default: './assets/' + model.split('/').map(encodeURIComponent).join('/') }, speed: { type: 'number', default: 0.5, min: -4, max: 4 }, scale: { type: 'number', default: 1, min: 0.1, max: 4 } },
  }, null, 2)));
  add('DEPENDENCIES.json', Buffer.from(JSON.stringify({ three: THREE_VERSION, dracoSource: 'three/examples/jsm/libs/draco/gltf', basisBuild: 'vendor/basis/BUILD.json', offline: true }, null, 2)));
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, assetsDir, model] = process.argv.slice(2);
  if (!output || path.extname(output).toLowerCase() !== '.zip') throw new Error('Usage: node scripts/build-three-motif.mjs output.zip [assets-directory] [model.glb]');
  const files = buildThreeMotifFiles({ assetsDir, ...(model ? { model } : {}) });
  fs.writeFileSync(output, zipSync(files), { flag: 'wx' });
  console.log(`Created ${path.resolve(output)} (Three.js ${THREE_VERSION}, ${Object.keys(files).length} files)`);
}
