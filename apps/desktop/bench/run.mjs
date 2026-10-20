// apps/desktop/bench/run.mjs
//
// `npm run bench -- --task <id|glob>[,…] --model <id>[,…] [--skill <dir>]
//   [--driver claude] [--repeat N] [--out <dir>] [--timeout-min N] [--media-timeout-min N]
//   [--app-memory-mib N] [--budget-usd X]`
//
// Parses the matrix, runs the e2e preflight (built app, DISPLAY, ffmpeg on
// PATH) and hands off to Playwright with bench/playwright.bench.config.ts —
// Playwright because the e2e launcher it reuses needs a test context and its
// TypeScript transform. Task selection itself happens in bench.run.ts, where
// the TypeScript task loader lives.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { prepareE2EEnv } from '../scripts/run-e2e.mjs'

const require = createRequire(import.meta.url)
const BENCH = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(BENCH)
const REPO = path.resolve(ROOT, '..', '..')

const USAGE = `usage: npm run bench -- --task <id|glob>[,...] --model <id>[,...] [--skill <dir>]
       [--driver claude] [--repeat N] [--out <dir>] [--timeout-min N] [--media-timeout-min N]
       [--app-memory-mib N] [--budget-usd X]`

function main(argv) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        task: { type: 'string', multiple: true },
        model: { type: 'string', multiple: true },
        skill: { type: 'string', default: path.join(REPO, 'skills', 'weftcut') },
        driver: { type: 'string', default: 'claude' },
        repeat: { type: 'string', default: '1' },
        out: { type: 'string', default: path.join(BENCH, 'results') },
        'timeout-min': { type: 'string', default: '20' },
        // A 3.5-minute 1080p VP9 source spends ~12 min on its full proxy on a
        // two-core host with the app's single background thread.
        'media-timeout-min': { type: 'string', default: '30' },
        'app-memory-mib': { type: 'string' },
        'budget-usd': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }))
  } catch (e) {
    console.error(`[bench] ${e.message}\n${USAGE}`)
    return 2
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const list = (v) => (v ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)
  const tasks = list(values.task)
  const models = list(values.model)
  const repeat = Number(values.repeat)
  const timeoutMin = Number(values['timeout-min'])
  const mediaTimeoutMin = Number(values['media-timeout-min'])
  const appMemory = values['app-memory-mib'] === undefined ? undefined : Number(values['app-memory-mib'])
  const budget = values['budget-usd'] === undefined ? undefined : Number(values['budget-usd'])
  const problems = []
  if (!tasks.length) problems.push('--task is required')
  if (!models.length) problems.push('--model is required')
  if (!Number.isInteger(repeat) || repeat < 1) problems.push('--repeat must be a positive integer')
  if (!(timeoutMin > 0)) problems.push('--timeout-min must be positive')
  if (!(mediaTimeoutMin > 0)) problems.push('--media-timeout-min must be positive')
  // The app's own range for the setting (RESOURCE_MEMORY_RANGE).
  if (appMemory !== undefined && !(Number.isInteger(appMemory) && appMemory >= 1024 && appMemory <= 262144))
    problems.push('--app-memory-mib must be an integer from 1024 to 262144')
  if (budget !== undefined && !(budget > 0)) problems.push('--budget-usd must be positive')
  if (problems.length) {
    console.error(`[bench] ${problems.join('; ')}\n${USAGE}`)
    return 2
  }

  const { env, errors, notes } = prepareE2EEnv({ ...process.env })
  // The e2e notes about test tiers and the analyzer do not apply here; the
  // ffmpeg one does (the app shells out to it on import).
  for (const note of notes.filter((n) => /ffmpeg/i.test(n))) console.log(`[bench preflight] ${note}`)
  if (errors.length) {
    for (const error of errors) console.error(`[bench preflight] ${error}`)
    return 1
  }
  // One stamp for the whole invocation, fixed HERE: Playwright evaluates the
  // test file in more than one process, and every one of them must derive the
  // same run ids and result paths.
  const session = new Date().toISOString().replace(/[:.]/g, '-')
  const plan = {
    session,
    tasks,
    models,
    driver: values.driver,
    repeat,
    skill: path.resolve(values.skill),
    out: path.resolve(values.out, session),
    timeout_ms: Math.round(timeoutMin * 60_000),
    media_timeout_ms: Math.round(mediaTimeoutMin * 60_000),
    ...(appMemory !== undefined ? { app_memory_mib: appMemory } : {}),
    ...(budget !== undefined ? { budget_usd: budget } : {}),
  }
  console.log(`[bench] results → ${plan.out}`)
  const result = spawnSync(
    process.execPath,
    [require.resolve('@playwright/test/cli'), 'test', '-c', path.join(BENCH, 'playwright.bench.config.ts')],
    { cwd: ROOT, env: { ...env, WEFTCUT_BENCH_PLAN: JSON.stringify(plan) }, stdio: 'inherit' },
  )
  if (result.error) throw result.error
  return result.status ?? 1
}

process.exitCode = main(process.argv.slice(2))
