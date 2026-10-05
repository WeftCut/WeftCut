import { test, expect } from '@playwright/test'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { PNG } from 'pngjs'
import { zipSync } from 'fflate'
import { readMotifDirectory } from '../../src/main/motif/packageFiles'
import { launchApp, tmpDir } from './helpers/driver'
import { publishMotifDraft } from './helpers/motif'

const require = createRequire(import.meta.url)

function texture(red: number, blue: number): Buffer {
  const png = new PNG({ width: 2, height: 2 })
  for (let i = 0; i < png.data.length; i += 4) png.data.set([red, 0, blue, 255], i)
  return PNG.sync.write(png)
}

/** Small unlit triangle with an embedded PNG: GLTFLoader must fetch a local
 * GLB, then fetch its blob image. No downloaded models or fixture generators. */
function model(): Buffer {
  const positions = Buffer.from(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]).buffer)
  const uv = Buffer.from(new Float32Array([0, 0, 1, 0, 0.5, 1]).buffer)
  const png = texture(255, 0)
  const data = Buffer.concat([positions, uv, png])
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    buffers: [{ byteLength: data.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      { buffer: 0, byteOffset: positions.length, byteLength: uv.length },
      { buffer: 0, byteOffset: positions.length + uv.length, byteLength: png.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    images: [{ bufferView: 2, mimeType: 'image/png' }], textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, extensions: { KHR_materials_unlit: {} } }],
    extensionsUsed: ['KHR_materials_unlit'],
  }))
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)])
  const paddedData = Buffer.concat([data, Buffer.alloc((4 - data.length % 4) % 4)])
  const glb = Buffer.alloc(12 + 8 + paddedJson.length + 8 + paddedData.length)
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(paddedJson.length, 12); glb.writeUInt32LE(0x4e4f534a, 16)
  paddedJson.copy(glb, 20)
  const offset = 20 + paddedJson.length
  glb.writeUInt32LE(paddedData.length, offset); glb.writeUInt32LE(0x004e4942, offset + 4)
  paddedData.copy(glb, offset + 8)
  return glb
}

test('@serial Three.js Motif ZIP round-trip loads local modules, GLB and textures and refreshes asset-only edits', async () => {
  test.setTimeout(120_000)
  const directory = tmpDir('motif-local-source-')
  const userDataDir = tmpDir('motif-local-profile-')
  mkdirSync(path.join(directory, 'vendor'))
  mkdirSync(path.join(directory, 'assets'))
  const threeBuild = path.dirname(require.resolve('three'))
  for (const name of ['three.module.js', 'three.core.js']) copyFileSync(path.join(threeBuild, name), path.join(directory, 'vendor', name))
  buildSync({ entryPoints: [require.resolve('three/addons/loaders/GLTFLoader.js')], bundle: true,
    format: 'esm', external: ['three'], outfile: path.join(directory, 'vendor', 'loader.js') })
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    name: 'Local Three Scene', size: [64, 64], default_duration_s: 2, props_schema: {},
  }))
  writeFileSync(path.join(directory, 'index.html'), `<!doctype html><html><head>
    <link rel="stylesheet" href="./scene.css">
    <script type="importmap">{"imports":{"three":"./vendor/three.module.js"}}</script>
    </head><body><script type="module" src="./scene.js"></script></body></html>`)
  writeFileSync(path.join(directory, 'scene.css'), 'html,body{margin:0;background:transparent}canvas{display:block}')
  writeFileSync(path.join(directory, 'assets', 'model.glb'), model())
  writeFileSync(path.join(directory, 'assets', 'texture.png'), texture(255, 0))
  const sceneSource = (scale: number) => `
    import * as THREE from 'three';
    import { GLTFLoader } from './vendor/loader.js';
    let renderer, scene, camera, mesh;
    motif.define({
      async setup(props, ctx) {
        renderer?.dispose(); document.body.replaceChildren();
        renderer = new THREE.WebGLRenderer({alpha:true}); renderer.setSize(64,64);
        document.body.append(renderer.domElement);
        scene = new THREE.Scene(); camera = new THREE.OrthographicCamera(-1,1,1,-1,0.1,10); camera.position.z = 2;
        const gltf = await new GLTFLoader().loadAsync('./assets/model.glb');
        const texture = await new THREE.TextureLoader().loadAsync('./assets/texture.png');
        texture.colorSpace = THREE.SRGBColorSpace;
        gltf.scene.traverse(o => { if (o.isMesh) { o.material.map = texture; o.material.needsUpdate = true; } });
        mesh = gltf.scene; scene.add(mesh); mesh.scale.setScalar(${scale});
        if (await (await fetch('data:text/plain,embedded')).text() !== 'embedded') throw new Error('data fetch failed');
      },
      frame(t) { mesh.rotation.z = t; renderer.render(scene,camera); }
    });`
  writeFileSync(path.join(directory, 'scene.js'), sceneSource(1))
  const sourceZip = path.join(tmpDir('motif-source-zip-'), 'scene.zip')
  writeFileSync(sourceZip, zipSync(Object.fromEntries(
    readMotifDirectory(directory).map(file => [`scene/${file.path}`, file.bytes]),
  )))

  const { app, page } = await launchApp({ userDataDir })
  try {
    const invoke = <T>(command: string, args: Record<string, unknown> = {}) => page.evaluate(
      async ({ command, args }) => (window as any).api.backend.invoke(command, args), { command, args },
    ) as Promise<T>
    const sourceId = (await invoke<{draft_id:string}>('open_motif_draft', { source:{kind:'zip',path:sourceZip} })).draft_id
    const archive = path.join(tmpDir('motif-zip-'), 'scene.zip')
    await invoke('export_motif', { id: sourceId, path: archive })
    const id = (await invoke<{draft_id:string}>('open_motif_draft', { source:{kind:'zip',path:archive} })).draft_id
    expect(id).not.toBe(sourceId)
    const catalog = () => invoke<Array<{ id: string; content_hash: string }>>('list_motifs')
    const hash = async (motifId: string) => (await catalog()).find(m => m.id === motifId)!.content_hash
    const capture = async (motifId: string, tSec: number, contentHash: string) => {
      const bytes = await page.evaluate(async (args) => {
        const data = await (window as any).api.backend.invoke('motif_capture_frame', args)
        return Array.from(data as Uint8Array)
      }, { motifId, tSec, propsJson: '{}', width: 64, height: 64, settleRafs: 2, contentHash })
      return Buffer.from(bytes)
    }
    const firstHash = await hash(id)
    const first = await capture(id, 0, firstHash)
    const pixels = PNG.sync.read(first)
    const center = (32 * 64 + 32) * 4
    expect([...pixels.data.subarray(center, center + 4)]).toEqual([255, 0, 0, 255])
    expect((await capture(id, 0.4, firstHash)).equals(first)).toBe(false)
    expect((await capture(id, 0, firstHash)).equals(first)).toBe(true) // backward seek

    const confinement = await app.evaluate(async ({ webContents }, motifId) => {
      const host = webContents.getAllWebContents().find(w => w.getURL().startsWith(`motif://${motifId}/`))!
      return host.executeJavaScript(`(async () => {
        const urls = ['https://example.invalid/model.glb', 'http://127.0.0.1:40000/model.glb',
          'motif://countdown/index.html', 'file:///not-a-motif', 'weftcut-media://not-a-motif'];
        const blocked = [];
        for (const url of urls) {
          const violation = new Promise(resolve => document.addEventListener('securitypolicyviolation',
            e => resolve(e.effectiveDirective), {once:true}));
          const failed = await fetch(url).then(() => false, () => true);
          blocked.push({failed, directive: await violation});
        }
        const blob = URL.createObjectURL(new Blob(['local-buffer']));
        const value = await (await fetch(blob)).text(); URL.revokeObjectURL(blob);
        return {blocked, value, hasNode: typeof require !== 'undefined'};
      })()`)
    }, id)
    expect(confinement.blocked).toEqual(Array.from({ length: 5 }, () => ({ failed: true, directive: 'connect-src' })))
    expect(confinement.value).toBe('local-buffer')
    expect(confinement.hasNode).toBe(false)

    const publishedId = await publishMotifDraft(page, id)
    expect(publishedId).not.toBe(id)
    const publishedHash = await hash(publishedId)
    expect((await capture(publishedId, 0, publishedHash)).equals(first)).toBe(true)
    const installed = path.join(userDataDir, 'data', 'motifs', publishedId)
    writeFileSync(path.join(installed, 'assets', 'texture.png'), texture(0, 255))
    writeFileSync(path.join(installed, 'scene.js'), sceneSource(0.5))
    const changedHash = await hash(publishedId)
    expect(changedHash).not.toBe(publishedHash)
    const updated = PNG.sync.read(await capture(publishedId, 0, changedHash))
    expect([...updated.data.subarray(center, center + 4)]).toEqual([0, 0, 255, 255])
    // The smaller triangle proves the unversioned companion JS refreshed too.
    expect(updated.data[(48 * 64 + 32) * 4 + 3]).toBe(0)
    expect(pixels.data[(48 * 64 + 32) * 4 + 3]).toBe(255)
    // Publication retains an independent draft; installed edits cannot alter it.
    expect(await hash(id)).toBe(firstHash)
    expect((await capture(id, 0, firstHash)).equals(first)).toBe(true)
  } finally { await app.close() }
})
