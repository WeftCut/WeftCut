import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('an interrupted worker leaves the last started test durable before reporter finalization', { timeout: 5000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-live-report-'))
  const report = path.join(folder, 'parallel.json')
  const reporter = new URL('../live-reporter.mjs', import.meta.url).href
  const program = `
    const {default: Reporter} = await import(${JSON.stringify(reporter)});
    const r = new Reporter();
    r.onBegin();
    r.onTestBegin({titlePath: () => ['parallel', 'blocked export'], location: {file: 'export.spec.ts'}}, {retry: 0, workerIndex: 1});
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: report }, stdio: 'pipe' })
  const exited = once(child, 'close')
  try {
    await once(child.stdout, 'data')
    child.kill('SIGKILL')
    await exited
    const lines = fs.readFileSync(path.join(folder, 'parallel.live.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(lines.map(line => line.event), ['begin', 'test-begin'])
    assert.deepEqual(lines[1].title, ['parallel', 'blocked export'])
    assert.equal(fs.existsSync(report), false)
  } finally {
    child.kill('SIGKILL')
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
