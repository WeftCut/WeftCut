// Runner: one Electron process per (arm, streams), results collected into
// results/<tag>/ with a summary table. Must run in an interactive session on
// Windows so the renderer gets a real GPU (see FINDINGS.md "Reproduce").
//   node poc/preview-thread-split/run.mjs [--arms=idle,main,decode-worker,all-worker] [--streams=1,2,3] [--tag=name] [--warmup=3] [--sample=15]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const argv = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v = '1'] = a.slice(2).split('='); return [k, v] }))
const arms = (argv.arms || 'idle,main,decode-worker,all-worker').split(',')
const streamCounts = (argv.streams || '1,2,3').split(',').map(Number)
const tag = argv.tag || new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(HERE, 'results', tag)
fs.mkdirSync(outDir, { recursive: true })
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const fixture = argv.fixture || path.join(ROOT, 'apps/desktop/e2e/fixtures/decode-bench/h264-2160.mp4')
const log = msg => { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); fs.appendFileSync(path.join(outDir, 'run.log'), line + '\n') }

function runOne(arm, streams) {
  const out = path.join(outDir, `${arm}-${streams}.json`)
  const args = [HERE, `--arm=${arm}`, `--streams=${streams}`, `--fixture=${fixture}`, `--out=${out}`]
  for (const k of ['warmup', 'sample', 'hw', 'gpu']) if (argv[k]) args.push(`--${k}=${argv[k]}`)
  return new Promise(resolve => {
    log(`start ${arm} x${streams}`)
    const child = spawn(electron, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
    let stderr = ''
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => { log(`kill ${arm} x${streams} (timeout)`); child.kill() }, 150000)
    child.on('exit', code => {
      clearTimeout(timer)
      log(`exit ${arm} x${streams} code=${code}`)
      if (stderr.trim()) fs.writeFileSync(path.join(outDir, `${arm}-${streams}.stderr.log`), stderr)
      resolve(fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { arm, streams, errors: [`no result file, exit ${code}`] })
    })
  })
}

const rows = []
for (const arm of arms) for (const streams of (arm === 'idle' ? [0] : streamCounts)) rows.push(await runOne(arm, streams))

const f = (p, k = 'p99') => p ? p[k] : '-'
const lines = ['| arm | streams | rAF p50 | rAF p99 | rAF max | rAF >50 ms | long tasks (ms) | render interval p99 | render ms p99 | cib p99 | late p99 | late >50 | superseded | decoded/s | errors |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|']
for (const r of rows) {
  const m = r.monitor || {}, p = r.presenter || {}, s = r.streamsReport || []
  const cib = s.length ? Math.max(...s.map(x => x.createImageBitmapMs?.p99 ?? 0)) : '-'
  const late = s.length ? Math.max(...s.map(x => x.lateMs?.p99 ?? 0)) : '-'
  const late50 = s.length ? s.reduce((a, x) => a + (x.late50 || 0), 0) : '-'
  const decodedPerSec = s.length ? (s.reduce((a, x) => a + (x.sampledOutputs || 0), 0) / (r.sample || 15)).toFixed(1) : '-'
  const errors = [...(r.errors || []), ...s.flatMap(x => x.errors || [])].map(e => String(e).slice(0, 60)).join('; ')
  lines.push(`| ${r.arm} | ${r.streams} | ${f(m.rafIntervalMs, 'p50')} | ${f(m.rafIntervalMs)} | ${f(m.rafIntervalMs, 'max')} | ${m.rafFramesOver50ms ?? '-'} | ${m.longTasks ?? '-'} (${m.longTaskMs ?? '-'}) | ${f(p.renderIntervalMs)} | ${f(p.renderMs)} | ${cib} | ${late} | ${late50} | ${p.superseded ?? '-'} | ${decodedPerSec} | ${errors} |`)
}
const summary = lines.join('\n')
fs.writeFileSync(path.join(outDir, 'summary.md'), summary + '\n')
fs.writeFileSync(path.join(outDir, 'done'), 'ok')
log('done\n' + summary)
