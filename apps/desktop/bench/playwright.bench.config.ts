import { defineConfig } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

/// The bench is not a test suite: it lives outside `e2e/electron` (the e2e
/// config's testDir) and matches only its own entry file, so neither
/// `npm run e2e` nor CI can pick it up. Start it through `npm run bench`, which
/// supplies the run matrix in WEFTCUT_BENCH_PLAN.
export default defineConfig({
  testDir: '.',
  testMatch: '**/run.bench.ts',
  /// Per run, from the plan's agent timeout; see run.bench.ts.
  timeout: 0,
  retries: 0,
  /// Runs share one machine and the agent's wall clock is part of what is
  /// recorded; two apps exporting side by side would skew both.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  /// launchApp's resource journal writes here; nothing in it is bench evidence.
  outputDir: path.join(os.tmpdir(), 'weftcut-bench-playwright'),
})
