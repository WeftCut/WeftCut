import assert from 'node:assert/strict'
import test from 'node:test'

import { collectE2e, parseCargo, parseNodeTest, parseVitest, renderSummary, stripLog } from './ci-summary-lib.mjs'

const ESC = '\x1b'
const vitestLog = stripLog([
  `2026-01-01T00:00:01.0000000Z  ${ESC}[32m✓${ESC}[39m src/a/slow.test.ts (3 tests | 1 skipped) 900ms`,
  '2026-01-01T00:00:01.1000000Z      ✓ waits for the host  2500ms',
  '2026-01-01T00:00:01.2000000Z  ✓ src/b/fast.test.tsx (2 tests) 12ms',
  '2026-01-01T00:00:01.3000000Z  ↓ src/c/off.test.ts (1 test | 1 skipped)',
  '2026-01-01T00:00:02.0000000Z  Test Files  2 passed | 1 skipped (3)',
  '2026-01-01T00:00:02.0000000Z       Tests  4 passed | 2 skipped (6)',
  '2026-01-01T00:00:02.0000000Z    Duration  10.00s (transform 1.00s, setup 2.00s, import 3.00s, tests 4.00s, environment 5.00s)',
].join('\n'))

test('Vitest: the summary counts, phases and each file come from the default reporter', () => {
  const v = parseVitest(vitestLog)
  assert.deepEqual(v.tests, { passed: 4, skipped: 2 })
  assert.equal(v.wall, 10)
  assert.deepEqual(v.phases, { transform: 1, setup: 2, import: 3, tests: 4, environment: 5 })
  assert.deepEqual(v.fileRows.map((f) => [f.file, f.mark]), [['src/a/slow.test.ts', '✓'], ['src/b/fast.test.tsx', '✓'], ['src/c/off.test.ts', '↓']])
  assert.deepEqual(v.slowTests, [{ file: 'src/a/slow.test.ts', title: 'waits for the host', ms: 2500 }], 'a slow test belongs to the file line above it')
})

test('Vitest: a log without the closing summary is not mistaken for a run', () => {
  assert.equal(parseVitest(vitestLog.filter((l) => !l.includes('Duration'))), null)
})

test('cargo: every test binary of the run is summed', () => {
  const c = parseCargo(['test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured', 'noise', 'test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured'])
  assert.deepEqual(c, { binaries: 2, passed: 5, failed: 1, ignored: 1 })
})

test('node:test: the closing info block', () => {
  assert.deepEqual(parseNodeTest(['ℹ tests 5', 'ℹ pass 4', 'ℹ fail 1', 'ℹ skipped 0', 'ℹ duration_ms 1500.5']), { pass: 4, fail: 1, skipped: 0, ms: 1500.5 })
})

const report = (tests) => ({ suites: [{ file: 'e2e/electron/a.spec.ts', specs: tests.map(([title, status, results]) => ({ title, tests: [{ projectName: 'parallel', status, results }] })) }] })

test('e2e: a leg with only the live log still yields its results, and is named as partial', () => {
  const live = [
    { event: 'test-end', title: ['', 'parallel', 'e2e/electron/b.spec.ts', 'retried'], status: 'failed', duration: 1000, errors: [{ message: 'boom' }] },
    { event: 'test-end', title: ['', 'parallel', 'e2e/electron/b.spec.ts', 'retried'], status: 'passed', duration: 900 },
    { event: 'test-end', title: ['', 'parallel', 'e2e/electron/b.spec.ts', 'broken'], status: 'failed', duration: 100 },
  ].map((e) => JSON.stringify(e)).join('\n')
  const e2e = collectE2e([{ os: 'ubuntu', part: 'e2e-1', project: 'parallel', live }])
  assert.deepEqual(e2e.tests.map((t) => [t.title, t.status]), [['retried', 'flaky'], ['broken', 'unexpected']])
  assert.deepEqual(e2e.partial, ['linux e2e-1 parallel'])
})

const job = (name, conclusion, created, started, completed, steps = []) => ({ name, status: 'completed', conclusion, created_at: created, started_at: started, completed_at: completed, steps })
const run = { id: 1, url: 'https://github.com/o/r/actions/runs/1', sha: 'abcdef0123', branch: 'main', event: 'push' }
const jobs = [
  job('checks', 'success', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', '2026-01-01T00:06:00Z', [{ name: 'Unit tests (vitest)', conclusion: 'success' }]),
  job('e2e (ubuntu-latest, e2e-1)', 'failure', '2026-01-01T00:00:00Z', '2026-01-01T00:02:00Z', '2026-01-01T00:10:00Z', [{ name: 'E2E tests', conclusion: 'failure' }]),
  job('e2e (macos-latest, e2e-1)', 'success', '2026-01-01T00:00:00Z', '2026-01-01T00:20:00Z', '2026-01-01T00:30:00Z'),
]
const e2e = collectE2e([
  { os: 'ubuntu', part: 'e2e-1', project: 'parallel', json: report([['fails @serial', 'unexpected', [{ duration: 1000, errors: [{ message: 'Error: expected 1\n  at x' }] }]]]) },
  { os: 'macos', part: 'e2e-1', project: 'parallel', json: report([['retries', 'flaky', [{ duration: 2000, errors: [{ message: 'TimeoutError: hover' }] }, { duration: 500 }]]]) },
])

test('a red run says so first and lists the failed job, its failing step and the failed test with its error', () => {
  const md = renderSummary({ run, sourceIsThisRun: true, jobs, logs: { checks: vitestLog }, e2e, baseline: null })
  assert.match(md.split('\n')[0], /❌ electron-ci 失败 · Failed/)
  assert.match(md, /\*\*e2e-1 · linux\*\* 失败 · failed<br><sub>`E2E tests`<\/sub>/)
  assert.match(md, /a\.spec\.ts\*\* › fails `@serial`.*`Error: expected 1`/)
  assert.match(md, /a\.spec\.ts\*\* › retries.*first attempt failed.*`TimeoutError: hover`/)
})

test('a test tag never renders as a bare @mention', () => {
  const md = renderSummary({ run, sourceIsThisRun: true, jobs, e2e, baseline: null })
  assert.doesNotMatch(md, /(^|[^`])@serial/m)
})

test('timeline: one Mermaid section per job keeps its queue band and run bar on one row; the last job to finish is critical', () => {
  const md = renderSummary({ run, sourceIsThisRun: true, jobs, e2e, baseline: null })
  const gantt = md.slice(md.indexOf('```mermaid'), md.indexOf('```', md.indexOf('```mermaid') + 3))
  const sections = gantt.split('\n').filter((l) => l.trim().startsWith('section '))
  assert.equal(sections.length, jobs.length)
  const tail = gantt.slice(gantt.lastIndexOf('section '))
  assert.match(tail, /section e2e-1 · macos/)
  assert.match(tail, /:done,/, 'a job that waited for a runner draws its queue band')
  assert.match(tail, /:crit,/)
  assert.equal((gantt.match(/:crit,/g) ?? []).length, 1)
})

test('a section whose data cannot be read shows as unavailable instead of failing the summary', () => {
  const md = renderSummary({ run, sourceIsThisRun: true, jobs, logs: { checks: ['no vitest output here'] }, e2e, baseline: null })
  assert.match(md, /> Vitest：数据不可用 · unavailable/)
  assert.match(md, /测试闸门 · Test gates/, 'the rest of the summary is still written')
})

test('a summary of another run links to it; one of this run does not', () => {
  assert.match(renderSummary({ run, sourceIsThisRun: false, jobs, e2e, baseline: null }).split('\n')[0], /\[run 1\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)/)
  assert.doesNotMatch(renderSummary({ run, sourceIsThisRun: true, jobs, e2e, baseline: null }).split('\n')[0], /\[run 1\]/)
})
