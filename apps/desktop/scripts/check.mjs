// The one command to run before a PR: the local equivalent of electron-ci's
// `checks` and `rust-test` jobs. Commands must stay identical to the workflow's;
// check.test.mjs holds every cargo line to that.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url))) // apps/desktop
const OS_DIR = { win32: 'win', linux: 'linux', darwin: 'mac' }
const MANIFEST = 'native/Cargo.toml'
const DECODE_MANIFEST = 'native/decode/Cargo.toml'

function npmStep(script) {
  return { name: script, command: 'npm', args: ['run', script] }
}

function cargoStep(name, args, env = {}) {
  return { name, command: 'cargo', args, env }
}

/** Pure, so the per-OS environment is testable from any host. */
export function checkPlan({ platform, root, env = {}, skipRust = false }) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const os = OS_DIR[platform]
  if (!os) throw new Error(`Unsupported platform: ${platform}`)
  const lgpl = paths.join(root, 'resources', 'ffmpeg-lgpl', os)

  // Tests that shell out to ffmpeg or dlopen libav self-skip when it is absent,
  // so a missing PATH entry loses coverage instead of going red.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const toolDirs = [paths.join(root, 'resources', 'ffmpeg', os)]
  if (platform === 'win32') toolDirs.push(paths.join(lgpl, 'bin'))
  const toolPath = {
    [pathKey]: [...toolDirs, env[pathKey]].filter(Boolean).join(paths.delimiter),
  }

  // bindgen runs even for a check, so Clippy needs these as well as the tests.
  const decodeBuild =
    platform === 'win32'
      ? {
          FFMPEG_DIR: lgpl.replaceAll('\\', '/'),
          LIBCLANG_PATH: env.LIBCLANG_PATH ?? 'C:\\Program Files\\LLVM\\bin',
        }
      : { FFMPEG_DIR: lgpl }
  const decodeLoader = {
    linux: { LD_LIBRARY_PATH: paths.join(lgpl, 'lib') },
    darwin: { DYLD_FALLBACK_LIBRARY_PATH: paths.join(lgpl, 'lib') },
    win32: {},
  }[platform]

  const typescript = [
    npmStep('typecheck'),
    npmStep('test:scripts'),
    npmStep('mcp:catalog:check'),
    { ...npmStep('test'), env: toolPath },
  ]
  if (skipRust) return typescript

  const decodeArgs = ['test', '--manifest-path', DECODE_MANIFEST, '--features', 'test-noop']
  // VideoToolbox sessions are finite: concurrent ProRes decodes fail with VT -19092.
  if (platform === 'darwin') decodeArgs.push('--', '--test-threads=1')

  return [
    cargoStep('rustfmt', ['fmt', '--check', '--all', '--manifest-path', MANIFEST]),
    ...typescript,
    cargoStep(
      'clippy',
      ['clippy', '--manifest-path', MANIFEST, '--workspace', '--all-targets', '--', '-D', 'warnings'],
      decodeBuild,
    ),
    cargoStep('rust: eval', ['test', '-p', 'weftcut-eval', '--manifest-path', MANIFEST], toolPath),
    cargoStep('rust: conversion', ['test', '-p', 'weftcut-conversion', '--manifest-path', MANIFEST], toolPath),
    cargoStep('rust: reaper', ['test', '-p', 'weftcut-reaper', '--manifest-path', MANIFEST], toolPath),
    cargoStep(
      'rust: core',
      ['test', '--manifest-path', MANIFEST, '--lib', '--bins', '--features', 'test-noop'],
      toolPath,
    ),
    cargoStep('rust: decode', decodeArgs, { ...toolPath, ...decodeBuild, ...decodeLoader }),
  ]
}

function main() {
  const skipRust = process.argv.includes('--skip-rust')
  const steps = checkPlan({ platform: process.platform, root: ROOT, env: process.env, skipRust })

  // The binary rather than its folder: resources/ffmpeg/<os>/ is tracked through
  // a .gitkeep, so it exists on a fresh clone.
  const os = OS_DIR[process.platform]
  const required = [
    path.join(ROOT, 'resources', 'ffmpeg', os, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(ROOT, 'resources', 'ffmpeg-lgpl', os),
  ]
  const missing = required.filter((target) => !existsSync(target))
  if (missing.length > 0) {
    console.error(`Missing ${missing.join(', ')}. Run npm run bootstrap first.`)
    process.exit(1)
  }

  for (const step of steps) {
    console.log(`\n=== ${step.name}`)
    const result = spawnSync(step.command, step.args, {
      cwd: ROOT,
      env: { ...process.env, ...step.env },
      stdio: 'inherit',
      // npm is a .cmd on Windows, which Node only spawns through a shell.
      shell: process.platform === 'win32' && step.command === 'npm',
    })
    if (result.status !== 0) {
      console.error(`\ncheck failed at: ${step.name}`)
      process.exit(result.status ?? 1)
    }
  }
  console.log(`\ncheck passed: ${steps.length} steps`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
