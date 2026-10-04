import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { PNG } from 'pngjs'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildThreeMotifFiles } from '../../scripts/build-three-motif.mjs'
import { launchApp, tmpDir, newProject, driveExport } from './helpers/driver'

const fixtures = fileURLToPath(new URL('../../fixtures/motif-codecs/', import.meta.url))

function compressedGlb(texture?: string): Buffer {
  const json = JSON.parse(readFileSync(path.join(fixtures, 'box.gltf'), 'utf8'))
  const draco = readFileSync(path.join(fixtures, 'box.bin'))
  const uv = Buffer.from(new Float32Array(Array.from({ length: 24 }, (_, i) => [[0,0],[1,0],[1,1],[0,1]][i % 4]).flat()).buffer)
  const binary = Buffer.concat([draco, uv])
  json.buffers = [{ byteLength: binary.length }]
  json.bufferViews.push({ buffer: 0, byteOffset: draco.length, byteLength: uv.length })
  json.accessors.push({ bufferView: 1, componentType: 5126, count: 24, type: 'VEC2' })
  json.meshes[0].primitives[0].attributes.TEXCOORD_0 = 3
  json.materials = [{ pbrMetallicRoughness: { baseColorFactor: texture ? [1,1,1,1] : [1,0,0,1],
    ...(texture ? { baseColorTexture: { index: 0 } } : {}) }, extensions: { KHR_materials_unlit: {} } }]
  json.extensionsUsed.push('KHR_materials_unlit')
  if (texture) {
    json.images = [{ uri: texture }]
    json.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }]
    json.extensionsUsed.push('KHR_texture_basisu'); json.extensionsRequired.push('KHR_texture_basisu')
  }
  const source = Buffer.from(JSON.stringify(json))
  const padded = Buffer.concat([source, Buffer.alloc((4 - source.length % 4) % 4, 32)])
  const glb = Buffer.alloc(12 + 8 + padded.length + 8 + binary.length)
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20)
  const offset = 20 + padded.length
  glb.writeUInt32LE(binary.length, offset); glb.writeUInt32LE(0x004e4942, offset + 4); binary.copy(glb, offset + 8)
  return glb
}

function packageFiles(texture?: string) {
  const assetsDir = tmpDir('motif-codec-assets-')
  writeFileSync(path.join(assetsDir, 'model.glb'), compressedGlb(texture))
  if (texture) writeFileSync(path.join(assetsDir, texture), readFileSync(path.join(fixtures, texture)))
  const files = buildThreeMotifFiles({ assetsDir }) as Record<string, Uint8Array>
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString())
  manifest.size = [128, 128]
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest))
  // Observe actual decoder Worker creation/retirement, without replacing them.
  files['scene.js'] = Buffer.from(`
    window.codecWorkers = {created:0,live:0};
    const W = window.Worker;
    window.Worker = class extends W {
      constructor(...args) {super(...args);this.live=true;window.codecWorkers.created++;window.codecWorkers.live++;}
      terminate(){if(this.live){this.live=false;window.codecWorkers.live--;}super.terminate();}
    };
  ` + Buffer.from(files['scene.js']).toString())
  return files
}

test('Motif compressed models: Draco, ETC1S and UASTC render, seek and rebuild through the official template', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  const client = new Client({name:'e2e-codec-import',version:'0.0.0'}, {capabilities:{}})
  app.context().on('page', p => p.on('pageerror', error => console.log('[motif codec page]', error.stack)))
  try {
    const info = await page.evaluate(() => (window as any).api.mcp.getInfo())
    await client.connect(new StreamableHTTPClientTransport(new URL(info.url), {
      requestInit: {headers:{Authorization:`Bearer ${info.bearer_token}`}},
    }))
    expect((await client.listTools()).tools.map(t => t.name)).toContain('import_motif')
    const invoke = (command: string, args: Record<string, unknown> = {}) => page.evaluate(
      ({ command, args }) => (window as any).api.backend.invoke(command, args), { command, args })
    for (const texture of [undefined, 'etc1s.ktx2', 'uastc.ktx2']) {
      const files = packageFiles(texture)
      const zip = path.join(tmpDir('motif-codec-zip-'), 'model.zip')
      writeFileSync(zip, zipSync(files))
      const imported = await client.callTool({name:'import_motif',arguments:{path:zip}})
      expect(imported.isError).toBeFalsy()
      const id = JSON.parse((imported.content as Array<{text:string}>)[0].text).draft_id as string
      const catalog = await invoke('list_motifs')
      const contentHash = catalog.find((m: any) => m.id === id).content_hash
      const capture = async (tSec: number, scale = 1) => Buffer.from(await page.evaluate(async args => Array.from(
        await (window as any).api.backend.invoke('motif_capture_frame', args) as Uint8Array), {
        motifId: id, tSec, propsJson: JSON.stringify({ model: './assets/model.glb', speed: 0.5, scale }),
        width: 128, height: 128, settleRafs: 2, contentHash,
      }))
      const first = await capture(0)
      const pixels = PNG.sync.read(first)
      const center = (64 * 128 + 64) * 4
      expect(pixels.data[center + 3]).toBe(255)
      if (!texture) expect([...pixels.data.subarray(center, center + 4)]).toEqual([255, 0, 0, 255])
      else expect(pixels.data.some((v, i) => i % 4 !== 3 && v > 50)).toBe(true)
      expect((await capture(1)).equals(first)).toBe(false)
      expect((await capture(0)).equals(first)).toBe(true)
      const workerState = () => app.evaluate(async ({ webContents }, id) => {
        const host = webContents.getAllWebContents().find(w => w.getURL().startsWith('motif://' + id + '/'))!
        return host.executeJavaScript('window.codecWorkers')
      }, id)
      const initialWorkers = await workerState()
      expect(initialWorkers.created).toBeGreaterThanOrEqual(texture ? 2 : 1)
      expect(initialWorkers.live).toBe(0)
      expect((await capture(0, 0.5)).equals(first)).toBe(false)
      expect((await workerState()).live).toBe(0)
      expect((await workerState()).created).toBeGreaterThan(initialWorkers.created)
    }
  } finally { await client.close(); await app.close() }
})

test('Motif decoder failures report setup errors and a healthy package can render afterwards', async () => {
  test.setTimeout(90_000)
  const {app, page} = await launchApp()
  try {
    for (const failure of ['missing-draco', 'corrupt-basis', 'healthy']) {
      const files = packageFiles('etc1s.ktx2')
      if (failure === 'missing-draco') delete files['vendor/draco/draco_decoder.wasm']
      if (failure === 'corrupt-basis') files['assets/etc1s.ktx2'] = Buffer.from('not a KTX2 texture')
      const zip = path.join(tmpDir('motif-codec-failure-'), 'model.zip')
      writeFileSync(zip, zipSync(files))
      const id = await page.evaluate(path => (window as any).api.backend.invoke('import_motif', {path}), zip)
      const result = await page.evaluate(async id => {
        try {
          const png = await (window as any).api.backend.invoke('motif_capture_frame', {
            motifId:id,tSec:0,propsJson:JSON.stringify({model:'./assets/model.glb',scale:1,speed:0.5}),
            width:128,height:128,settleRafs:2,contentHash:id,
          })
          return {bytes:png.length,error:''}
        } catch (error) { return {bytes:0,error:String(error)} }
      }, id)
      if (failure === 'healthy') expect(result.bytes, result.error).toBeGreaterThan(100)
      else {
        expect(result.error, failure).toMatch(/__motifSetup/)
        expect(result.error).toMatch(/model\.glb|Worker|worker/)
      }
    }
  } finally { await app.close() }
})

test('Motif local and Blob workers retain offline CSP and deny JS eval', async () => {
  test.setTimeout(60_000)
  const worker = `self.onmessage = async ({data}) => {
    const blocked = [];
    for (const url of data.urls) {
      const violation = new Promise(resolve => self.addEventListener('securitypolicyviolation', e => resolve(e.effectiveDirective), {once:true}));
      const failed = await fetch(url).then(() => false, () => true);
      blocked.push({failed, directive: await violation});
    }
    const local = await (await fetch(data.local)).text();
    await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));
    let evalBlocked = false; try {new Function('return 1')();} catch {evalBlocked = true;}
    self.postMessage({blocked,local,evalBlocked,hasNode:typeof require !== 'undefined'});
  };`
  const files = {
    'manifest.json': Buffer.from(JSON.stringify({name:'Worker Confinement',size:[64,64],default_duration_s:1,props_schema:{}})),
    'probe-worker.js': Buffer.from(worker), 'local.txt': Buffer.from('package-local'),
    'index.html': Buffer.from(`<html><body><script>
      window.results = [];
      motif.define({async setup(){
        const blob = URL.createObjectURL(new Blob([${JSON.stringify(worker)}], {type:'text/javascript'}));
        try {for (const source of ['./probe-worker.js', blob]) {
          const w = new Worker(source);
          const result = new Promise((resolve,reject)=>{w.onmessage=e=>resolve(e.data);w.onerror=reject;});
          w.postMessage({local:location.origin+'/local.txt',urls:['https://example.invalid/asset','http://127.0.0.1:40000/asset','motif://countdown/index.html','file:///not-a-motif','weftcut-media://not-a-motif']});
          window.results.push(await result);
        }} finally {URL.revokeObjectURL(blob);}
      },frame(){document.body.style.background='red';}});
    </script></body></html>`),
  }
  const zip = path.join(tmpDir('motif-confinement-'), 'workers.zip')
  writeFileSync(zip, zipSync(files))
  const { app, page } = await launchApp()
  try {
    const id = await page.evaluate(path => (window as any).api.backend.invoke('import_motif', {path}), zip)
    await page.evaluate(id => (window as any).api.backend.invoke('motif_capture_frame', {
      motifId:id,tSec:0,propsJson:'{}',width:64,height:64,settleRafs:2,contentHash:'confinement',
    }), id)
    const results = await app.evaluate(async ({webContents}, id) => {
      const host = webContents.getAllWebContents().find(w=>w.getURL().startsWith('motif://'+id+'/'))!
      return host.executeJavaScript('window.results')
    }, id)
    expect(results).toEqual(Array.from({length:2},()=>({
      local:'package-local',evalBlocked:true,hasNode:false,
      blocked:Array.from({length:5},()=>({failed:true,directive:'connect-src'})),
    })))
  } finally { await app.close() }
})

test('Motif Draco + Basis package animates through the export frame stream', async () => {
  test.skip(process.env.WEFTCUT_E2E_NO_EXPORT === '1', 'Video encoding unavailable on this runner')
  test.setTimeout(180_000)
  const zip = path.join(tmpDir('motif-codec-export-'), 'model.zip')
  writeFileSync(zip, zipSync(packageFiles('etc1s.ktx2')))
  const { app, page } = await launchApp()
  try {
    await newProject(page, { parentFolder: tmpDir('motif-codec-project-'), name: 'compressed-model', canvas: { width: 320, height: 320, fpsNum: 30, fpsDen: 1 } })
    const motifId = await page.evaluate(path => (window as any).api.backend.invoke('import_motif', { path }), zip)
    const output = path.join(tmpDir('motif-codec-video-'), 'model.mp4')
    const result = await driveExport(page, { motifId, outputAbsPath: output, durationUs: 1_000_000 }, { hook: 'exportMotifClip', timeout: 150_000 })
    expect(result.done.ok, result.done.error).toBe(true)
    expect(readFileSync(output).length).toBeGreaterThan(1000)
    const perf = await page.evaluate(() => (window as any).__weftcutExportPerf)
    expect(perf.motif.framesRead).toBe(30)
    const frame = (index: number) => execFileSync(process.env.FFMPEG || 'ffmpeg', [
      '-v','error','-i',output,'-vf',`select=eq(n\\,${index})`,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1',
    ], {windowsHide:true})
    const first = frame(0), last = frame(29)
    expect(first.length).toBe(320 * 320 * 3)
    expect(last.length).toBe(first.length)
    expect(first.some(value => value > 50)).toBe(true)
    const difference = first.reduce((sum, value, i) => sum + Math.abs(value - last[i]), 0) / first.length
    expect(difference).toBeGreaterThan(1)
  } finally { await app.close() }
})
