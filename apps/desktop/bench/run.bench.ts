// apps/desktop/bench/run.bench.ts
//
// The Playwright entry for `npm run bench`: one test per (task, model, repeat)
// cell of the plan run.mjs passes in. A test fails only when the run could not
// produce its evidence (launch, setup, driver crash) — an agent that edits
// badly is a result, not a failure.

import { test } from '@playwright/test'
import path from 'node:path'
import { runOne, summaryLine, type HostPlan, type PlannedRun } from './runner'
import { loadTasks } from './tasks'

interface Plan {
  session: string
  tasks: string[]
  models: string[]
  driver: string
  repeat: number
  skill: string
  out: string
  timeout_ms: number
  media_timeout_ms: number
  app_memory_mib?: number
  budget_usd?: number
  host: HostPlan
  rebuild_templates: boolean
}

const raw = process.env.WEFTCUT_BENCH_PLAN
if (!raw) throw new Error('WEFTCUT_BENCH_PLAN is unset — start the bench with `npm run bench`, not Playwright directly')
const plan = JSON.parse(raw) as Plan

/// A model id can hold `/` or `:` (provider-qualified names); keep the
/// directory name portable.
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_')

const runs: PlannedRun[] = loadTasks(plan.tasks).flatMap((task) =>
  plan.models.flatMap((model) =>
    Array.from({ length: plan.repeat }, (_, i) => {
      const name = `${task.id}__${slug(plan.driver)}-${slug(model)}__r${i + 1}`
      return {
        run_id: `${plan.session}/${name}`, task, model, driver: plan.driver, skill_path: plan.skill,
        out_dir: path.join(plan.out, name), timeout_ms: plan.timeout_ms, media_timeout_ms: plan.media_timeout_ms,
        host: plan.host, rebuild_templates: plan.rebuild_templates,
        ...(plan.app_memory_mib !== undefined ? { app_memory_mib: plan.app_memory_mib } : {}),
        ...(plan.budget_usd !== undefined ? { budget_usd: plan.budget_usd } : {}),
      }
    })))

/// The client's account limit, as the driver reports it. Once one run hits it,
/// every later run would fail in seconds and record nothing but the error, so
/// the rest of the plan is skipped instead (runs go one at a time, in order).
const ACCOUNT_LIMIT = /session limit|usage limit|weekly limit|rate.?limit/i
let accountLimit: string | null = null

for (const run of runs) {
  test(run.run_id, async () => {
    test.skip(accountLimit !== null, `skipped after the client's account limit: ${accountLimit}`)
    // The agent's own budget and the media wait, plus app launch, setup and
    // the closing snapshots.
    test.setTimeout(run.timeout_ms + run.media_timeout_ms + 5 * 60_000)
    const result = await runOne(run)
    process.stdout.write(summaryLine(result, run.out_dir) + '\n')
    if (result.error && ACCOUNT_LIMIT.test(result.error)) accountLimit = result.error
    if (!result.final_project) throw new Error(`run produced no evidence: ${result.error}`)
  })
}
