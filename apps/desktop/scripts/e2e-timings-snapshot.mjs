// Refresh e2e/timings.json — the measured cost the e2e split is packed from
// (e2e/slices.mjs) — from one electron-ci run's `e2e-timings-<os>-<part>`
// artifacts and the step timings of its carrier legs.
//
//   node scripts/e2e-timings-snapshot.mjs <run-id> [--repo owner/name]
//
// The run should be a GREEN push run of all three OSes: a red leg stops at its
// `maxFailures`, and a scoped dispatch runs one OS on one `all` slice, so neither
// measures what a leg costs. The script refuses a run that is not a green push
// run, and a run whose timings reports are missing an OS or whose parallel
// project reports a failure.
//
// Per spec file, the cost is the SUM of its results' durations in the parallel
// project (retries included — a leg pays for them), per OS, in whole seconds. A
// spec on disk that no parallel report mentions ran and selected nothing there
// (its tests are all @serial), so it is recorded at 0 — distinct from a spec
// ADDED after the snapshot, which is absent and gets slices.mjs's default cost.
// A spec an OS skips (slices.mjs §SKIP_ON) was not run there at all: its cost
// on that OS is carried over from the previous snapshot, or left absent if it
// was never measured, so that lifting the skip later packs it at a real or
// default cost rather than at zero.
// The three once-per-OS extras — the serial project, the packaging step and
// the decode-bench fixture generation — are recorded by their wall clock, since
// each rides one leg whole. Reading cost per OS matters: a spec that is 2 min on
// Linux is often 1 min on macOS, and the split is balanced per OS.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SKIP_ON } from '../e2e/slices.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SNAPSHOT = path.resolve(HERE, '..', 'e2e', 'timings.json')

export const SPEC_DIR = path.resolve(HERE, '..', 'e2e', 'electron')

export const OSES = ['windows-latest', 'ubuntu-latest', 'macos-latest']

/// Workflow step names whose wall clock is an extra's cost. Kept here, next to
/// the one reader, and asserted against the workflow text by
/// scripts/e2e-split.test.mjs so a renamed step is loud.
export const EXTRA_STEPS = {
  package: 'Package (unsigned)',
  decodeBench: 'Generate software-lane family fixtures (e2e)',
}

/** Per spec file, the summed duration of every result in a Playwright JSON
 * report, in milliseconds. Suites nest; a spec's file is the nearest `file`
 * above it. Also returns whether any test's outcome was unexpected, since a
 * stopped leg's report is not a measurement. */
export function fileCostsFromReport(report) {
  const costs = new Map()
  let unexpected = 0
  const walk = (suite, file) => {
    const own = suite.file ?? file
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status === 'unexpected') unexpected++
        const ms = (test.results ?? []).reduce((sum, r) => sum + (r.duration ?? 0), 0)
        costs.set(own, (costs.get(own) ?? 0) + ms)
      }
    }
    for (const child of suite.suites ?? []) walk(child, own)
  }
  for (const suite of report.suites ?? []) walk(suite, undefined)
  return { costs, unexpected }
}

/** `e2e-timings-<os>-<part>` → { os, part }, or null for any other name. */
export function parseArtifactName(name) {
  const m = /^e2e-timings-(windows-latest|ubuntu-latest|macos-latest)-(.+)$/.exec(name)
  return m ? { os: m[1], part: m[2] } : null
}

/** Fold the downloaded artifact directories into the snapshot's `seconds`
 * table. `dirs` maps artifact name → { parallel?, serial? } parsed JSON;
 * `specs` is every spec file the run covered (the checkout's, by default);
 * `previous` is the snapshot being replaced, for the per-OS skips. */
export function foldReports(dirs, specs = specFilesOnDisk(), { skipOn = SKIP_ON, previous = null } = {}) {
  const parallel = {}
  const serial = {}
  const seen = new Set()
  for (const [name, reports] of Object.entries(dirs)) {
    const id = parseArtifactName(name)
    if (!id) continue
    seen.add(id.os)
    if (reports.parallel) {
      const { costs, unexpected } = fileCostsFromReport(reports.parallel)
      if (unexpected) throw new Error(`${name}: ${unexpected} unexpected test outcome(s) — a stopped leg is not a measurement; pick a green run`)
      for (const [file, ms] of costs) {
        parallel[file] ??= {}
        parallel[file][id.os] = (parallel[file][id.os] ?? 0) + ms
      }
    }
    if (reports.serial) {
      if (serial[id.os] !== undefined) throw new Error(`${id.os}: two legs report a serial project`)
      serial[id.os] = reports.serial.stats.duration
    }
  }
  for (const want of OSES) {
    if (!seen.has(want)) throw new Error(`no e2e-timings-${want}-* artifact — the snapshot needs all three OSes`)
    if (serial[want] === undefined) throw new Error(`no leg of ${want} reports the serial project`)
  }
  for (const spec of specs) parallel[spec] ??= {}
  for (const [file, byOs] of Object.entries(parallel)) {
    for (const want of OSES) {
      if (skipOn[want]?.includes(file)) {
        // Not run there. Keep what the last snapshot knew, in milliseconds to
        // match the rest of the table; absent stays absent.
        const kept = previous?.seconds?.parallel?.[file]?.[want]
        if (kept !== undefined) byOs[want] = kept * 1000
        else delete byOs[want]
      } else {
        byOs[want] ??= 0
      }
    }
  }
  const round = (table) => Object.fromEntries(Object.entries(table).map(([k, v]) => [k, Math.round(v / 1000)]))
  return {
    parallel: Object.fromEntries(
      Object.keys(parallel).sort().map((file) => [file, round(parallel[file])]),
    ),
    serial: round(serial),
  }
}

export function specFilesOnDisk(dir = SPEC_DIR) {
  return readdirSync(dir).filter((name) => name.endsWith('.spec.ts')).sort()
}

/** Wall clock of the named steps on the one leg per OS that ran each. */
export function extrasFromJobs(jobs) {
  const out = Object.fromEntries(Object.keys(EXTRA_STEPS).map((k) => [k, {}]))
  for (const job of jobs) {
    const m = /^e2e \((windows-latest|ubuntu-latest|macos-latest), /.exec(job.name)
    if (!m) continue
    for (const [extra, stepName] of Object.entries(EXTRA_STEPS)) {
      const step = (job.steps ?? []).find((s) => s.name === stepName && s.conclusion === 'success')
      if (!step) continue
      const seconds = Math.round((Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000)
      if (seconds === 0) continue // a skipped step reports success with no duration
      if (out[extra][m[1]] !== undefined) throw new Error(`${m[1]}: "${stepName}" ran on two legs`)
      out[extra][m[1]] = seconds
    }
  }
  for (const [extra, byOs] of Object.entries(out))
    for (const want of OSES)
      if (byOs[want] === undefined) throw new Error(`no leg of ${want} ran "${EXTRA_STEPS[extra]}"`)
  return out
}

/// A push run is the only one whose legs run what every PR and push leg runs. A
/// dispatch can turn on the native-decode gates (`decode_e2e`) or the @matrix
/// tier, and the nightly runs both; their specs then cost minutes that an
/// ordinary leg skips in seconds, and the pack starves the leg holding them.
export function assertMeasurableRun(runId, run) {
  if (run.event !== 'push') throw new Error(`run ${runId} is a ${run.event} run — pick a green push run on main`)
  if (run.conclusion !== 'success') throw new Error(`run ${runId} concluded "${run.conclusion}" — pick a green run`)
}

const gh = (args, opts = {}) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts })

function readReports(dir) {
  const out = {}
  for (const name of readdirSync(dir)) {
    const reports = {}
    for (const project of ['parallel', 'serial']) {
      try {
        reports[project] = JSON.parse(readFileSync(path.join(dir, name, `${project}.json`), 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    out[name] = reports
  }
  return out
}

async function main(argv) {
  const repoAt = argv.indexOf('--repo')
  const repo = repoAt === -1 ? gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim() : argv[repoAt + 1]
  const runId = argv.find((a) => /^\d+$/.test(a))
  if (!runId) throw new Error('usage: node scripts/e2e-timings-snapshot.mjs <run-id> [--repo owner/name]')

  const run = JSON.parse(gh(['run', 'view', runId, '-R', repo, '--json', 'headSha,conclusion,event,createdAt,jobs']))
  assertMeasurableRun(runId, run)

  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-timings-'))
  try {
    gh(['run', 'download', runId, '-R', repo, '--pattern', 'e2e-timings-*', '-D', dir])
    let previous = null
    try {
      previous = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const seconds = foldReports(readReports(dir), specFilesOnDisk(), { previous })
    const jobs = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, '--jq', '.jobs'])).map((job) => ({ name: job.name, steps: job.steps }))
    Object.assign(seconds, extrasFromJobs(jobs))
    const snapshot = {
      $comment: 'Measured e2e cost per OS, read by e2e/slices.mjs to pack the CI split. Refresh with `npm run e2e:timings -- <green run id>`; never edit by hand.',
      run: Number(runId),
      commit: run.headSha,
      measured: run.createdAt.slice(0, 10),
      seconds,
    }
    writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`)
    const files = Object.keys(seconds.parallel).length
    console.log(`wrote ${path.relative(process.cwd(), SNAPSHOT)}: ${files} spec files, run ${runId} (${run.headSha.slice(0, 8)}, ${snapshot.measured})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
