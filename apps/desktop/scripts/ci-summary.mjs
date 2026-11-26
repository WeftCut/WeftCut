// Write the run summary of one electron-ci run (rendering: ci-summary-lib.mjs).
//
//   node scripts/ci-summary.mjs [--run <id>] [--repo owner/name] [--artifacts <dir>] [--out <file>]
//
// --run and --repo default to the current Actions run; --out defaults to
// $GITHUB_STEP_SUMMARY, else stdout. --artifacts is the directory the run's
// `e2e-timings-<os>-<part>` artifacts were downloaded into. Needs a token with
// `actions: read` in GH_TOKEN or GITHUB_TOKEN.
import { existsSync, readdirSync, readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectE2e, renderSummary, stripLog } from './ci-summary-lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function args(argv) {
  const out = { run: process.env.GITHUB_RUN_ID, repo: process.env.GITHUB_REPOSITORY, artifacts: null, out: process.env.GITHUB_STEP_SUMMARY }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
  }
  if (!out.run || !out.repo) throw new Error('--run and --repo are required outside GitHub Actions')
  return out
}

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
async function api(p, { text = false } = {}) {
  const res = await fetch(`https://api.github.com/${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } })
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`)
  return text ? res.text() : res.json()
}

async function jobsOf(repo, run) {
  const jobs = []
  for (let page = 1; ; page++) {
    const r = await api(`repos/${repo}/actions/runs/${run}/jobs?per_page=100&page=${page}`)
    jobs.push(...r.jobs)
    if (jobs.length >= r.total_count || !r.jobs.length) return jobs
  }
}

/** A log that cannot be read leaves its section marked unavailable rather than failing the summary. */
async function logOf(repo, job) {
  try { return stripLog(await api(`repos/${repo}/actions/jobs/${job.id}/logs`, { text: true })) } catch (err) { console.warn(`log of ${job.name}: ${err.message}`); return null }
}

function e2eEntries(dir) {
  const entries = []
  if (!dir || !existsSync(dir)) return entries
  for (const d of readdirSync(dir)) {
    const m = d.match(/^e2e-timings-(\w+)-latest-([\w-]+)$/)
    if (!m) continue
    const files = readdirSync(path.join(dir, d))
    const projects = new Set(files.map((f) => f.replace(/(\.live\.jsonl|\.json)$/, '')))
    for (const project of projects) {
      const json = files.includes(`${project}.json`) ? JSON.parse(readFileSync(path.join(dir, d, `${project}.json`), 'utf8')) : null
      const live = files.includes(`${project}.live.jsonl`) ? readFileSync(path.join(dir, d, `${project}.live.jsonl`), 'utf8') : null
      if (json || live) entries.push({ os: m[1], part: m[2], project, json, live })
    }
  }
  return entries
}

const opt = args(process.argv.slice(2))
const run = await api(`repos/${opt.repo}/actions/runs/${opt.run}`)
// Jobs still running — this summary's own job among them — have no times to show.
const jobs = (await jobsOf(opt.repo, opt.run)).filter((j) => j.status === 'completed')
const logs = { rust: {} }
const checks = jobs.find((j) => j.name === 'checks' && j.conclusion !== 'skipped')
if (checks) logs.checks = await logOf(opt.repo, checks)
for (const j of jobs) {
  const m = j.name.match(/^rust-test \((\w+)-latest\)$/)
  if (m && j.conclusion !== 'skipped') logs.rust[m[1]] = await logOf(opt.repo, j)
}
const timings = path.resolve(HERE, '..', 'e2e', 'timings.json')
const baseline = existsSync(timings) ? JSON.parse(readFileSync(timings, 'utf8')).seconds?.parallel ?? null : null

const md = renderSummary({
  run: { id: run.id, url: run.html_url, sha: run.head_sha, branch: run.head_branch, event: run.event, attempt: run.run_attempt },
  sourceIsThisRun: String(opt.run) === process.env.GITHUB_RUN_ID,
  jobs,
  logs,
  e2e: collectE2e(e2eEntries(opt.artifacts)),
  baseline,
})
if (opt.out) appendFileSync(opt.out, md)
else process.stdout.write(md)
