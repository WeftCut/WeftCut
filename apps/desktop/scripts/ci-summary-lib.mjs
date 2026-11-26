// Pure half of the electron-ci run summary: parses one run's job list, job logs
// and e2e reports, and renders the bilingual (Chinese, then English) Markdown
// written to $GITHUB_STEP_SUMMARY. Fetching lives in ci-summary.mjs.
//
// Only this run's data. Cross-run statistics belong to a separate scheduled
// report, so this never downloads another run's artifacts.
import path from 'node:path'

const OS_ORDER = ['ubuntu', 'windows', 'macos']
const OS_LABEL = { ubuntu: 'linux', windows: 'windows', macos: 'macos' }

export const T = (iso) => Date.parse(iso) / 1000
export const fmt = (s) => (s >= 90 ? `${(s / 60).toFixed(1)}m` : `${Math.round(s)}s`)
const bar = (v, max, width) => '▇'.repeat(Math.max(1, Math.round((v / max) * width)))
/** Test titles carry tags such as `@serial`; bare, GitHub renders them as user mentions. */
const esc = (t) => t.replace(/@(\w[\w-]*)/g, '`@$1`')

/** Job log text without the per-line timestamp and ANSI colour codes. */
export function stripLog(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r$/, ''))
}

const counts = (s) => Object.fromEntries([...s.matchAll(/(\d+) (passed|failed|skipped|todo)/g)].map((m) => [m[2], +m[1]]))

/** Vitest's default reporter: one line per file, an indented line per slow test, and the closing summary. */
export function parseVitest(lines) {
  const testsLine = lines.find((l) => /^\s+Tests\s+\d/.test(l))
  const durLine = lines.find((l) => /^\s+Duration\s+[\d.]+s/.test(l))
  if (!testsLine || !durLine) return null
  const filesLine = lines.find((l) => /^\s*Test Files\s+\d/.test(l)) ?? ''
  const files = [], slow = []
  let cur = null
  for (const l of lines) {
    let m = l.match(/^ ([✓×↓❯]) (src\/\S+) \(([^)]*)\)(?: (\d+)ms)?/)
    if (m) { cur = m[2]; files.push({ file: m[2], mark: m[1], tests: +(m[3].match(/(\d+) tests?/)?.[1] ?? 0), ms: +(m[4] ?? 0) }); continue }
    m = l.match(/^\s{3,}[✓×] (.*?)\s+(\d+)ms$/)
    if (m && cur) slow.push({ file: cur, title: m[1], ms: +m[2] })
  }
  return {
    tests: counts(testsLine),
    files: counts(filesLine),
    wall: +durLine.match(/Duration\s+([\d.]+)s/)[1],
    phases: Object.fromEntries([...durLine.matchAll(/(\w+) ([\d.]+)s/g)].map((m) => [m[1], +m[2]])),
    fileRows: files,
    slowTests: slow,
  }
}

/** node --test's closing `ℹ name value` block. */
export function parseNodeTest(lines) {
  const v = (k) => { const l = lines.find((x) => x.startsWith(`ℹ ${k} `)); return l == null ? null : +l.split(' ')[2] }
  if (v('tests') == null) return null
  return { pass: v('pass'), fail: v('fail'), skipped: v('skipped'), ms: v('duration_ms') }
}

/** Every libtest `test result:` line of a cargo run, summed. */
export function parseCargo(lines) {
  const rs = lines.filter((l) => l.includes('test result:'))
  if (!rs.length) return null
  const n = (l, k) => +(l.match(new RegExp(`(\\d+) ${k}`))?.[1] ?? 0)
  return { binaries: rs.length, passed: rs.reduce((a, l) => a + n(l, 'passed'), 0), failed: rs.reduce((a, l) => a + n(l, 'failed'), 0), ignored: rs.reduce((a, l) => a + n(l, 'ignored'), 0) }
}

/** Tests of one Playwright JSON report, flattened with their spec file. */
function testsOfReport(report) {
  const out = []
  const walk = (suite, file) => {
    const own = suite.file ?? file
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) out.push({ file: path.basename(own ?? '?'), title: spec.title, project: t.projectName, status: t.status, results: t.results ?? [] })
    for (const c of suite.suites ?? []) walk(c, own)
  }
  for (const s of report.suites ?? []) walk(s)
  return out
}

/** A leg cut off before Playwright's final JSON (maxFailures, cancellation) left only the live JSONL. */
function testsOfLive(jsonl, project) {
  const byTitle = new Map()
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.event !== 'test-end') continue
    const key = e.title.join(' › ')
    const t = byTitle.get(key) ?? { file: path.basename(e.title[2] ?? e.title[1] ?? '?'), title: e.title.at(-1), project, results: [] }
    t.results.push({ status: e.status, duration: e.duration, errors: e.errors ?? [] })
    byTitle.set(key, t)
  }
  for (const t of byTitle.values()) {
    const last = t.results.at(-1).status, first = t.results[0].status
    t.status = last === 'passed' ? (first === 'passed' ? 'expected' : 'flaky') : last === 'skipped' ? 'skipped' : 'unexpected'
  }
  return [...byTitle.values()]
}

/** `entries`: { os, part, project, json?, live? } per report file found in the e2e-timings artifacts. */
export function collectE2e(entries) {
  const tests = []
  const partial = []
  for (const e of entries) {
    const list = e.json ? testsOfReport(e.json) : e.live ? testsOfLive(e.live, e.project) : []
    if (!e.json && e.live) partial.push(`${OS_LABEL[e.os]} ${e.part} ${e.project}`)
    for (const t of list) tests.push({ ...t, os: e.os, part: e.part })
  }
  return { tests, partial }
}

const firstError = (r) => ((r?.errors?.[0]?.message ?? r?.error?.message ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 110)

// ---------------------------------------------------------------- render

const th = (zh, en) => `${zh}<br>${en}`
const both = (zh, en) => `${zh}<br>${en}`
const note = (zh, en) => `<sub>${zh}<br>${en}</sub>`
const H = (icon, zh, en) => `### ${icon} ${zh} · ${en}`
const unavailable = (what, err) => `> ${what}：数据不可用 · unavailable${err ? ` — \`${String(err).slice(0, 120)}\`` : ''}`

/** Run a section; a parse failure shows as one line instead of failing the summary. */
function section(out, name, fn) {
  try { fn() } catch (err) { out.push(unavailable(name, err.message), '') }
}

const osOf = (name) => OS_ORDER.find((os) => name.includes(`${os}-latest`))
const shortJob = (name) => {
  let m = name.match(/^e2e \((\w+)-latest, ([\w-]+)\)$/); if (m) return `${m[2]} · ${OS_LABEL[m[1]]}`
  m = name.match(/^rust-test \((\w+)-latest\)$/); if (m) return `rust · ${OS_LABEL[m[1]]}`
  return name
}

/**
 * model: {
 *   run: { id, url, sha, branch, event, attempt }, sourceIsThisRun,
 *   jobs: GitHub job objects (completed ones only),
 *   logs: { checks?: string[], rust?: { [os]: string[] } },
 *   e2e: collectE2e(...), baseline: e2e/timings.json `seconds.parallel` or null,
 *   mermaidInfo?: boolean
 * }
 */
export function renderSummary(model) {
  const { run, jobs, logs = {}, e2e = { tests: [], partial: [] }, baseline } = model
  const o = []
  const q = (j) => T(j.started_at) - T(j.created_at)
  const r = (j) => T(j.completed_at) - T(j.started_at)
  const ran = jobs.filter((j) => j.started_at && j.completed_at && j.conclusion !== 'skipped')

  const failedJobs = jobs.filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out')
  const cancelled = jobs.some((j) => j.conclusion === 'cancelled')
  const flaky = e2e.tests.filter((t) => t.status === 'flaky')
  const failedTests = e2e.tests.filter((t) => t.status === 'unexpected')

  // E2E cost per spec and OS in the parallel project, the unit timings.json records.
  const cost = {}
  for (const t of e2e.tests) if (t.project === 'parallel') { const k = `${t.file}|${t.os}`; cost[k] = (cost[k] ?? 0) + t.results.reduce((a, x) => a + (x.duration ?? 0), 0) / 1000 }
  const specCosts = Object.entries(cost).map(([k, s]) => { const [spec, os] = k.split('|'); const b = baseline?.[spec]?.[`${os}-latest`]; return { spec, os, s, b, x: b ? s / b : 0 } })
  const isSlow = (x) => x.b >= 10 && x.x >= 1.5 && x.s - x.b >= 15
  const regress = specCosts.filter(isSlow).sort((a, b) => b.x - a.x)

  // ---- headline
  const status = failedJobs.length ? ['❌', '失败', 'Failed'] : cancelled ? ['⚪', '已取消', 'Cancelled'] : ['✅', '通过', 'Passed']
  const where = model.sourceIsThisRun ? '' : ` · [run ${run.id}](${run.url})`
  o.push(`## ${status[0]} electron-ci ${status[1]} · ${status[2]} · \`${run.sha.slice(0, 7)}\` · ${run.branch} · ${run.event}${where}`, '')
  const nz = [], ne = []
  if (failedJobs.length) { nz.push(`❌ **${failedJobs.length} 个 job 失败**`); ne.push(`❌ **${failedJobs.length} job${failedJobs.length > 1 ? 's' : ''} failed**`) }
  if (failedTests.length) { nz.push(`❌ **${failedTests.length} 个 E2E 测试失败**`); ne.push(`❌ **${failedTests.length} E2E test${failedTests.length > 1 ? 's' : ''} failed**`) }
  if (flaky.length) { nz.push(`🟨 **${flaky.length} 个测试重试后才通过**`); ne.push(`🟨 **${flaky.length} test${flaky.length > 1 ? 's' : ''} passed only on retry**`) }
  if (regress.length) { nz.push(`🐢 ${regress.length} 个 spec 比基线慢 ≥1.5×`); ne.push(`🐢 ${regress.length} spec${regress.length > 1 ? 's' : ''} ≥1.5× slower than baseline`) }
  if (nz.length) o.push(`> ${nz.join(' · ')}<br>`, `> ${ne.join(' · ')}`, '')

  // ---- key numbers
  section(o, '关键数字 · Key numbers', () => {
    if (!ran.length) throw new Error('no completed jobs')
    const t0 = Math.min(...jobs.map((j) => T(j.created_at)))
    const wall = Math.max(...ran.map((j) => T(j.completed_at))) - t0
    const longQ = ran.reduce((a, b) => (q(a) > q(b) ? a : b)), longR = ran.reduce((a, b) => (r(a) > r(b) ? a : b))
    const last = ran.filter((j) => r(j) >= 60).reduce((a, b) => (T(a.completed_at) > T(b.completed_at) ? a : b), longR)
    const lost = flaky.reduce((a, t) => a + (t.results[0]?.duration ?? 0) / 1000, 0)
    o.push(`| ${th('总时长', 'Total')} | ${th('最长排队', 'Longest queue')} | ${th('最长运行', 'Longest run')} | ${th('决定结束时间的 job', 'Job that set the end')} | ${th('重试浪费', 'Lost to retries')} |`, '|:-:|:-:|:-:|:-:|:-:|')
    o.push(`| **${fmt(wall)}** | ${fmt(q(longQ))}<br><sub>${shortJob(longQ.name)}</sub> | ${fmt(r(longR))}<br><sub>${shortJob(longR.name)}</sub> | ${shortJob(last.name)}<br><sub>⏳ ${fmt(q(last))} + ${fmt(r(last))}</sub> | ${flaky.length} · ${fmt(lost)} |`, '')
  })

  // ---- gates
  const vitest = logs.checks ? parseVitest(logs.checks) : null
  const nodeTest = logs.checks ? parseNodeTest(logs.checks) : null
  const stepOf = (job, name) => job?.steps?.find((s) => s.name === name)
  const mark = (c) => (c === 'success' ? '✅' : c === 'skipped' || c == null ? '⚪' : c === 'cancelled' ? '⚪' : '❌')
  section(o, '测试闸门 · Test gates', () => {
    const rows = []
    const checks = jobs.find((j) => j.name === 'checks')
    if (checks) {
      const vs = stepOf(checks, 'Unit tests (vitest)'), ns = stepOf(checks, 'Build-script tests (node:test)')
      rows.push(`| Vitest | ${mark(vs?.conclusion)} | ${vitest ? `${(vitest.tests.passed ?? 0).toLocaleString('en')} <sub>${vitest.files.passed ?? '?'} files</sub>` : '—'} | ${vitest?.tests.failed ?? 0} | ${vitest?.tests.skipped ?? '—'} | — | ${vitest ? fmt(vitest.wall) : vs?.completed_at ? fmt(T(vs.completed_at) - T(vs.started_at)) : '—'} |`)
      rows.push(`| node:test | ${mark(ns?.conclusion)} | ${nodeTest?.pass ?? '—'} | ${nodeTest?.fail ?? 0} | ${nodeTest?.skipped ?? '—'} | — | ${nodeTest ? fmt(nodeTest.ms / 1000) : '—'} |`)
    }
    for (const os of OS_ORDER) {
      const j = jobs.find((x) => x.name === `rust-test (${os}-latest)`); if (!j) continue
      const c = logs.rust?.[os] ? parseCargo(logs.rust[os]) : null
      rows.push(`| Rust · ${OS_LABEL[os]} | ${mark(j.conclusion)} | ${c ? `${c.passed.toLocaleString('en')} <sub>${c.binaries} binaries</sub>` : '—'} | ${c?.failed ?? '—'} | ${c?.ignored ?? '—'} | — | ${j.started_at && j.completed_at ? `${fmt(r(j))} <sub>job</sub>` : '—'} |`)
    }
    for (const os of OS_ORDER) {
      const legs = jobs.filter((j) => j.name.startsWith('e2e (') && osOf(j.name) === os); if (!legs.length) continue
      const ts = e2e.tests.filter((t) => t.os === os)
      const n = (s) => ts.filter((t) => t.status === s).length
      const res = legs.some((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out') ? '❌' : n('flaky') ? '🟨' : legs.every((j) => j.conclusion === 'success') ? '✅' : '⚪'
      const times = legs.filter((j) => j.started_at && j.completed_at && j.conclusion !== 'skipped').map(r)
      rows.push(`| E2E · ${OS_LABEL[os]} | ${res} | ${ts.length ? `${(n('expected') + n('flaky')).toLocaleString('en')} <sub>${legs.length} leg${legs.length > 1 ? 's' : ''}</sub>` : '—'} | ${n('unexpected') ? `**${n('unexpected')}**` : 0} | ${n('skipped')} | ${n('flaky') ? `**${n('flaky')}**` : 0} | ${times.length ? (times.length > 1 ? `${fmt(Math.min(...times))}–${fmt(Math.max(...times))} <sub>per leg</sub>` : fmt(times[0])) : '—'} |`)
    }
    if (!rows.length) throw new Error('no test jobs in this run')
    o.push(H('🚦', '测试闸门', 'Test gates'), '', `| ${th('闸门', 'Gate')} | ${th('结果', 'Result')} | ${th('通过', 'Passed')} | ${th('失败', 'Failed')} | ${th('跳过', 'Skipped')} | ${th('重试后过', 'Passed on retry')} | ${th('耗时', 'Time')} |`, '|---|:-:|--:|--:|--:|:-:|--:|', ...rows, '')
  })

  // ---- needs attention
  section(o, '需要关注 · Needs attention', () => {
    const items = []
    const runUrl = `${run.url}#artifacts`
    for (const j of failedJobs) {
      const steps = (j.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => s.name)
      items.push(`- ❌ **${shortJob(j.name)}** 失败 · failed${steps.length ? `<br><sub>${steps.map((s) => `\`${s}\``).join(', ')}</sub>` : ''}`)
    }
    for (const t of failedTests.slice(0, 10)) items.push(`- ❌ **${t.file}** › ${esc(t.title)}<br><sub>${OS_LABEL[t.os]} ${t.part} · \`${firstError(t.results.at(-1))}\` · [trace](${runUrl})</sub>`)
    if (failedTests.length > 10) items.push(`- ${both(`另有 ${failedTests.length - 10} 个失败测试`, `${failedTests.length - 10} more failed tests`)}`)
    for (const t of flaky) items.push(`- 🟨 **${t.file}** › ${esc(t.title)}<br><sub>${OS_LABEL[t.os]} ${t.part} · 第 1 次失败 · first attempt failed (${fmt((t.results[0]?.duration ?? 0) / 1000)}): \`${firstError(t.results[0])}\` · [trace](${runUrl})</sub>`)
    for (const x of regress.slice(0, 3)) items.push(`- 🐢 **${x.spec}** · ${OS_LABEL[x.os]}：${both(`用了 ${fmt(x.s)}，基线 ${fmt(x.b)}（${x.x.toFixed(1)}×）`, `took ${fmt(x.s)} against a ${fmt(x.b)} baseline (${x.x.toFixed(1)}×)`)}`)
    for (const p of e2e.partial) items.push(`- ⚠️ ${both(`${p} 没有最终报告，只用了实时记录`, `${p} has no final report; read from the live log`)}`)
    if (!items.length) return
    o.push(H('⚠️', '需要关注', 'Needs attention'), '', ...items, '')
  })

  // ---- timeline
  section(o, 'Job 时间线 · Job timeline', () => {
    const shown = ran.filter((j) => r(j) >= 60)
    if (!shown.length) return
    const last = shown.reduce((a, b) => (T(a.completed_at) > T(b.completed_at) ? a : b))
    const iso = (t) => new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const groupOf = (j) => (j.name.startsWith('e2e') ? 2 : j.name.startsWith('rust') ? 1 : 0)
    const osRank = (j) => Math.max(0, OS_ORDER.indexOf(osOf(j.name)))
    shown.sort((a, b) => groupOf(a) - groupOf(b) || osRank(a) - osRank(b) || a.name.localeCompare(b.name))
    o.push(H('⏱️', 'Job 时间线', 'Job timeline'), '', note('灰 = 排队等 runner · 蓝 = 运行 · 红 = 决定结束时间的 job', 'grey = waiting for a runner · blue = running · red = the job that set the end'), '')
    o.push('```mermaid', '---', 'displayMode: compact', 'config:', '  gantt:', '    leftPadding: 120', '---', 'gantt', '  dateFormat YYYY-MM-DD HH:mm:ss', '  axisFormat %H:%M', '  tickInterval 10minute')
    // One section per job: compact mode then keeps a job's queue band and run bar
    // on one row, and never packs another job's bar into that row.
    for (const j of shown) {
      o.push(`  section ${shortJob(j.name).replace(/[:,#;]/g, ' ')}`)
      if (q(j) >= 30) o.push(`  ​ :done, ${iso(T(j.created_at))}, ${Math.round(q(j))}s`)
      o.push(`  ${fmt(r(j))} :${j === last ? 'crit' : 'active'}, ${iso(T(j.started_at))}, ${Math.round(r(j))}s`)
    }
    o.push('```', '')
  })

  // ---- e2e split balance
  section(o, 'E2E 分片均衡 · E2E split balance', () => {
    const legs = {}
    for (const j of ran) { const m = j.name.match(/^e2e \((\w+)-latest, ([\w-]+)\)$/); if (m) (legs[m[2]] ??= {})[m[1]] = j }
    const all = Object.values(legs).flatMap((v) => Object.values(v).map(r))
    if (all.length < 2) return
    const mean = all.reduce((a, b) => a + b) / all.length
    const col = (v) => (v > mean * 1.15 ? '🟥' : v > mean * 1.05 ? '🟧' : v < mean * 0.85 ? '🟦' : '🟩')
    const oses = OS_ORDER.filter((os) => Object.values(legs).some((v) => v[os]))
    o.push(H('🧩', 'E2E 分片均衡', 'E2E split balance'), '', `| | ${oses.map((os) => OS_LABEL[os]).join(' | ')} |`, `|---|${oses.map(() => ':-:').join('|')}|`)
    for (const leg of Object.keys(legs).sort()) o.push(`| **${leg}** | ${oses.map((os) => (legs[leg][os] ? `${col(r(legs[leg][os]))} ${fmt(r(legs[leg][os]))}` : '—')).join(' | ')} |`)
    o.push('', note(`与均值 ${fmt(mean)} 比：🟦 快 >15% · 🟩 ±5% · 🟧 慢 5–15% · 🟥 慢 >15%`, `vs the ${fmt(mean)} mean: 🟦 >15% faster · 🟩 ±5% · 🟧 5–15% slower · 🟥 >15% slower`), '')
  })

  // ---- vitest
  if (logs.checks) section(o, 'Vitest', () => {
    if (!vitest) throw new Error('no Vitest summary in the checks log')
    const phases = ['tests', 'import', 'environment', 'setup', 'transform'].filter((k) => vitest.phases[k] != null)
    const cum = phases.reduce((a, k) => a + vitest.phases[k], 0)
    const par = (cum / vitest.wall).toFixed(1), ovh = Math.round(((cum - (vitest.phases.tests ?? 0)) / cum) * 100)
    const skippedFiles = vitest.fileRows.filter((f) => f.mark === '↓').length
    o.push(H('🧪', 'Vitest', 'unit tests'), '', both(`**${fmt(vitest.wall)}** 墙钟 · 并行约 **${par}×** · 非测试开销 **${ovh}%** · 跳过 ${skippedFiles} 个文件`, `${fmt(vitest.wall)} wall clock · about ${par}× parallel · non-test overhead ${ovh}% · ${skippedFiles} file${skippedFiles === 1 ? '' : 's'} skipped`), '')
    const dmax = Math.max(...phases.map((k) => vitest.phases[k]))
    o.push('**各阶段累计耗时 · Time per phase, summed over workers**', '', `| ${phases.join(' | ')} |`, `|${phases.map(() => ':-:').join('|')}|`, `| ${phases.map((k) => `**${vitest.phases[k].toFixed(0)}s**<br>\`${bar(vitest.phases[k], dmax, 8)}\``).join(' | ')} |`, '')
    const top = [...vitest.fileRows].sort((a, b) => b.ms - a.ms).slice(0, 6)
    if (top.length && top[0].ms) {
      o.push('**最慢的测试文件（仅测试执行）· Slowest test files (test execution only)**', '', `| ${th('文件', 'File')} | ${th('测试数', 'Tests')} | ${th('耗时', 'Time')} | |`, '|---|--:|--:|---|')
      for (const f of top) o.push(`| \`${path.basename(f.file)}\`<br><sub>${path.dirname(f.file)}</sub> | ${f.tests} | ${fmt(f.ms / 1000)} | \`${bar(f.ms, top[0].ms, 10)}\` |`)
      o.push('')
    }
    const slow = [...vitest.slowTests].sort((a, b) => b.ms - a.ms).filter((t) => t.ms >= 2000)
    if (slow.length) {
      o.push(`<details><summary>${slow.length} 个单测 ≥ 2s · ${slow.length} tests ≥ 2s</summary>`, '', `| ${th('测试', 'Test')} | ${th('文件', 'File')} | ${th('耗时', 'Time')} |`, '|---|---|--:|')
      for (const t of slow.slice(0, 10)) o.push(`| ${esc(t.title.slice(0, 70))} | \`${path.basename(t.file)}\` | ${fmt(t.ms / 1000)} |`)
      o.push('', '</details>', '')
    }
  })

  // ---- slowest e2e specs
  section(o, 'E2E 最慢的 spec · Slowest E2E specs', () => {
    if (!specCosts.length) return
    const specs = {}
    for (const x of specCosts) (specs[x.spec] ??= {})[x.os] = x
    const oses = OS_ORDER.filter((os) => specCosts.some((x) => x.os === os))
    const top = Object.entries(specs).sort((a, b) => Math.max(...Object.values(b[1]).map((x) => x.s)) - Math.max(...Object.values(a[1]).map((x) => x.s))).slice(0, 10)
    o.push('<details><summary>E2E 最慢的 spec（按 OS）· Slowest E2E specs by OS</summary>', '', `| spec | ${oses.map((os) => OS_LABEL[os]).join(' | ')} |`, `|---|${oses.map(() => '--:').join('|')}|`)
    for (const [spec, v] of top) o.push(`| \`${spec}\` | ${oses.map((os) => (v[os] ? `${fmt(v[os].s)}${isSlow(v[os]) ? ' 🐢' : ''}` : '—')).join(' | ')} |`)
    o.push('', note('🐢 = 比 `e2e/timings.json` 基线慢 ≥1.5× 且多 15s 以上', '🐢 = ≥1.5× and ≥15 s slower than the `e2e/timings.json` baseline'), '', '</details>', '')
  })

  if (model.mermaidInfo) o.push('<details><summary>Mermaid version</summary>', '', '```mermaid', 'info', '```', '', '</details>', '')
  return o.join('\n') + '\n'
}
