// Run after npm run build:wasm. Measures the shipped Rust/Wasm batch call,
// including request serialization and result decoding; no timing assertions.
import { performance } from 'node:perf_hooks'
import { CONVERSION_WASM_BASE64 } from '../src/renderer/eval/evalWasm.generated.ts'

const start = performance.now()
const e = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(CONVERSION_WASM_BASE64, 'base64'))).exports
console.log(`Wasm initialization: ${(performance.now() - start).toFixed(2)} ms`)
const key = (t_us, value) => ({ t_us, value, in_: [2 / 3, 2 / 3], out: [1 / 3, 1 / 3], segment: { kind: 'Linear' } })
const track = keys => ({ keys, extrapolate: { before: 'Hold', after: 'Hold' } })
const node = (x, y) => ({ point: { x, y }, incoming: { x: 0, y: 0 }, outgoing: { x: 0, y: 0 }, cubic: false })
const source = (seconds, curved = false) => ({
  nodes: [curved ? { ...node(0, 0), cubic: true, outgoing: { x: 0, y: 300 } } : node(0, 0),
    curved ? { ...node(600, 0), incoming: { x: 0, y: 300 } } : node(600, 0)],
  tracks: [track([key(0, 0), key(seconds * 1e6, 1)])],
  options: { fpsNum: 30, fpsDen: 1, startFrame: 0, endFrame: seconds * 30, tolerancePx: 1, everyFrames: 1, xyMode: 'editable' },
})
const run = request => {
  const bytes = new TextEncoder().encode(JSON.stringify(request))
  const ptr = e.conversion_input(bytes.length)
  new Uint8Array(e.memory.buffer, ptr, bytes.length).set(bytes)
  const len = e.conversion_run()
  const response = JSON.parse(new TextDecoder().decode(new Uint8Array(e.memory.buffer, e.conversion_output(), len)))
  if (!response.ok) throw new Error(response.code)
  return response.result
}
const long = source(2); long.options.endFrame = 30 * 600
const dense = source(10, true); dense.options.xyMode = 'bake'
const xy = source(10); xy.nodes = null
xy.tracks = [track([key(0, 0), key(1e7, 600)]), track([
  { ...key(0, 0), segment: { kind: 'Spline' }, out: [1 / 3, 0] }, { ...key(1e7, 300), in_: [2 / 3, 0] },
])]
for (const [name, request] of [['2s line', source(2)], ['10s curved path', source(10, true)], ['10min with static tail', long], ['10s explicit bake', dense], ['10s XY to path', xy]]) {
  const cold = performance.now(); let result = run(request); const first = performance.now() - cold
  const timings = []
  for (let i = 0; i < 9; i++) { const start = performance.now(); result = run(request); timings.push(performance.now() - start) }
  timings.sort((a, b) => a - b)
  console.log(JSON.stringify({ case: name, firstMs: +first.toFixed(2), medianMs: +timings[4].toFixed(2),
    keys: result.tracks.map(t => t.keys.length === 1 ? 0 : t.keys.length), nodes: result.nodeCount,
    errorPx: +result.maxErrorPx.toFixed(4), withinTolerance: result.withinTolerance }))
}
