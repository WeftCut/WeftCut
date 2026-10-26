// Linux x64: both napi addons are linked against napi-rs's prebuilt glibc 2.17
// cross toolchain (`napi build --use-napi-cross`), so the shipped .node files
// load on distros older than the build machine (issue #73; glibc-floor.mjs
// holds the result to the floor).
//
// LANDMINE — `--use-napi-cross` alone is not enough here. It points cc-rs at
// the toolchain through TARGET_CC/TARGET_CXX/TARGET_AR, but cc-rs ignores the
// TARGET_* names when the target triple equals the host's, which it does on an
// x64 build machine. The C dependencies (aws-lc-sys behind rustls, ring,
// blake3) are then compiled by the HOST gcc against the host's glibc headers,
// and a C23-default gcc turns sscanf/strtol into `__isoc23_*` imports that only
// glibc 2.38+ provides. The per-triple names below are the ones cc-rs reads in
// that case. Anything the caller already set wins, as napi's own variables do.
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LINUX_TRIPLE = 'x86_64-unknown-linux-gnu'

/**
 * Extra `napi build` arguments and environment for this host: the sysroot build
 * on Linux x64, nothing anywhere else (the package ships no other Linux arch).
 */
export function linuxSysroot(env = process.env, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'linux' || arch !== 'x64') return { args: '', env: {} }
  // The directory napi extracts the toolchain into on first use. The package is
  // the CLI's dependency, not ours, so resolve it from where the CLI does.
  const cli = createRequire(import.meta.url).resolve('@napi-rs/cli/package.json')
  const { version } = createRequire(cli)('@napi-rs/cross-toolchain')
  const bin = join(homedir(), '.napi-rs', 'cross-toolchain', version, LINUX_TRIPLE, 'bin')
  const suffix = LINUX_TRIPLE.replaceAll('-', '_')
  const tools = {}
  for (const [name, exe] of [['CC', 'gcc'], ['CXX', 'g++'], ['AR', 'ar']]) {
    const key = `${name}_${suffix}`
    if (!env[key]) tools[key] = join(bin, `${LINUX_TRIPLE}-${exe}`)
  }
  return { args: `--use-napi-cross --target ${LINUX_TRIPLE}`, env: tools }
}
