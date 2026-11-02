// `npm run check`: the one command to run before a PR. The steps live in
// check-plan.mjs. This file runs unconditionally: an "am I the entry point" guard
// compares a resolved path with a realpath, so under a junction or symlink it
// skipped everything and exited 0, which reads as a pass.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkPlan, OS_DIR } from './check-plan.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url))) // apps/desktop
const isWindows = process.platform === 'win32'

const skipRust = process.argv.includes('--skip-rust')
const steps = checkPlan({ platform: process.platform, root: ROOT, env: process.env, skipRust })

// The binary rather than its folder: resources/ffmpeg/<os>/ is tracked through a
// .gitkeep, so it exists on a fresh clone.
const os = OS_DIR[process.platform]
const required = [
  path.join(ROOT, 'resources', 'ffmpeg', os, isWindows ? 'ffmpeg.exe' : 'ffmpeg'),
  path.join(ROOT, 'resources', 'ffmpeg-lgpl', os),
]
const missing = required.filter((target) => !existsSync(target))
if (missing.length > 0) {
  console.error(`Missing ${missing.join(', ')}. Run npm run bootstrap first.`)
  process.exit(1)
}

// Every step runs, so one red gate cannot hide another.
const failed = []
for (const step of steps) {
  console.log(`\n=== ${step.name}`)
  const options = { cwd: ROOT, env: { ...process.env, ...step.env }, stdio: 'inherit' }
  // npm is a .cmd on Windows, which Node only spawns through a shell, and an args
  // array with a shell is deprecated (DEP0190). The arguments are constants.
  const result =
    isWindows && step.command === 'npm'
      ? spawnSync(`npm ${step.args.join(' ')}`, { ...options, shell: true })
      : spawnSync(step.command, step.args, options)
  if (result.status !== 0) failed.push(step.name)
}
if (failed.length > 0) {
  console.error(`\ncheck failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`\ncheck passed: ${steps.length} steps`)
