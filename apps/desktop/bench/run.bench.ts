// apps/desktop/bench/run.bench.ts
//
// The Playwright entry for `npm run bench`: one test per (task, model, repeat)
// cell of the plan run.mjs passes in. A test fails only when the run could not
// produce its evidence (launch, setup, driver crash) — an agent that edits
// badly is a result, not a failure.

import { test } from '@playwright/test'
import path from 'node:path'
import { runOne, summaryLine, type PlannedRun } from './runner'
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
  budget_usd?: number
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
        out_dir: path.join(plan.out, name), timeout_ms: plan.timeout_ms,
        ...(plan.budget_usd !== undefined ? { budget_usd: plan.budget_usd } : {}),
      }
    })))

for (const run of runs) {
  test(run.run_id, async () => {
    // The agent's own budget plus app launch, setup and the closing snapshots.
    test.setTimeout(run.timeout_ms + 5 * 60_000)
    const result = await runOne(run)
    process.stdout.write(summaryLine(result, run.out_dir) + '\n')
    if (!result.final_project) throw new Error(`run produced no evidence: ${result.error}`)
  })
}
