// What `npm run check` runs, as data, so the per-OS environment is testable from
// any host. Commands must stay identical to electron-ci's `checks` and `rust-test`
// jobs; check.test.mjs holds every cargo and Go line to that.
import path from 'node:path'

export const OS_DIR = { win32: 'win', linux: 'linux', darwin: 'mac' }

const MANIFEST = 'native/Cargo.toml'
const DECODE_MANIFEST = 'native/decode/Cargo.toml'

function npmStep(script) {
  return { name: script, command: 'npm', args: ['run', script] }
}

function cargoStep(name, args, env = {}) {
  return { name, command: 'cargo', args, env }
}

// The `weftcut` binary's module (apps/desktop/cli). CGO off as in its build
// (build-weftcut-cli.mjs): the gates judge the program that ships, and need no
// C compiler.
const GO_MODULE = 'cli'
const GO_ENV = { CGO_ENABLED: '0' }

function goSteps() {
  return [
    // gofmt exits 0 whatever it finds; the files it lists are the failure.
    { name: 'gofmt', command: 'gofmt', args: ['-l', GO_MODULE], failOnOutput: true },
    { name: 'go vet', command: 'go', args: ['-C', GO_MODULE, 'vet', './...'], env: GO_ENV },
    { name: 'go test', command: 'go', args: ['-C', GO_MODULE, 'test', './...'], env: GO_ENV },
  ]
}

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
    // The unit suite runs the binary as a client would (src/cli), and nothing
    // else rebuilds it: a stale one is judged in place of the Go sources.
    npmStep('build:cli'),
    { ...npmStep('test'), env: toolPath },
  ]
  if (skipRust) return [...goSteps(), ...typescript]

  const decodeArgs = ['test', '--manifest-path', DECODE_MANIFEST, '--features', 'test-noop']
  // VideoToolbox sessions are finite: concurrent ProRes decodes fail with VT -19092.
  if (platform === 'darwin') decodeArgs.push('--', '--test-threads=1')

  return [
    cargoStep('rustfmt', ['fmt', '--check', '--all', '--manifest-path', MANIFEST]),
    // Everything below reads the built addons, and nothing else rebuilds them: a
    // stale one makes the catalog check compare against the old tool table and pass.
    npmStep('napi:build'),
    npmStep('napi:build:decode'),
    ...goSteps(),
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
