import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { buildThreeMotifFiles } from './build-three-motif.mjs';

test('portable template carries pinned offline decoders and a self-contained demo model', () => {
  const files = buildThreeMotifFiles();
  const json = name => JSON.parse(Buffer.from(files[name]).toString());
  assert.equal(json('DEPENDENCIES.json').three, '0.186.1');
  assert.equal(json('manifest.json').props_schema.model.default, './assets/demo.gltf');
  assert.ok(files['vendor/draco/draco_decoder.wasm'].length > 100_000);
  const build = json('vendor/basis/BUILD.json');
  assert.ok(build.flags.includes('-sDYNAMIC_EXECUTION=0'));
  for (const [name, hash] of Object.entries(build.sha256)) {
    assert.equal(createHash('sha256').update(files['vendor/basis/' + name]).digest('hex'), hash);
  }
  const loader = Buffer.from(files['vendor/model-loader.js']).toString();
  assert.doesNotMatch(loader, /from ["']three\/addons\//);
  assert.match(loader, /setDRACOLoader/);
  assert.match(loader, /setKTX2Loader/);
  assert.match(loader, /setMeshoptDecoder/);
});

test('copies all model companions, encodes URL characters, and refuses escaping model paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'three-template-'));
  try {
    fs.writeFileSync(path.join(root, 'a # model.glb'), Buffer.from([0, 1, 255]));
    fs.writeFileSync(path.join(root, 'map.png'), Buffer.from([1, 2, 3]));
    const files = buildThreeMotifFiles({ assetsDir: root, model: 'a # model.glb' });
    assert.deepEqual(files['assets/a # model.glb'], Buffer.from([0, 1, 255]));
    assert.deepEqual(files['assets/map.png'], Buffer.from([1, 2, 3]));
    assert.equal(JSON.parse(Buffer.from(files['manifest.json']).toString()).props_schema.model.default, './assets/a%20%23%20model.glb');
    assert.throws(() => buildThreeMotifFiles({ assetsDir: root, model: '../secret.glb' }), /relative path/);
    assert.throws(() => buildThreeMotifFiles({ assetsDir: root, model: 'absent.glb' }), /not found/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
