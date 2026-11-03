---
status: accepted
---

# Linux addons link against an old glibc

Date: 2026-10-27

## Context

The Linux package failed to start on Ubuntu 22.04 (issue #73):
`@weftcut/core` needed GLIBC_2.38 and 2.39 because the addons were built on
`ubuntu-latest`, so their glibc floor followed the runner image. The 2.38
symbols (`__isoc23_sscanf`, `__isoc23_strtol`) came from aws-lc-sys (behind
rustls) compiled by the runner's C23-default gcc; the 2.39 ones were Rust std's
`pidfd_*`. Patching symbols one at a time cannot keep up; only building against
an older glibc can. The rest of the package needs at most 2.28 (Electron 44:
2.25, BtbN libav*: 2.28).

## Decision

- **Both addons link against napi-rs's glibc 2.17 cross toolchain**
  (`napi build --use-napi-cross`) on Linux x64, in the same npm scripts a
  developer runs (`scripts/napi-linux-sysroot.mjs`). C compilers are passed
  under cc-rs's per-triple names (`CC_x86_64_unknown_linux_gnu`, ...), because
  cc-rs ignores `TARGET_CC` when target and host triples match and would fall
  back to the host gcc.
- **The package promises glibc 2.28** (`GLIBC_FLOOR`). The bundled libva is
  conda-forge's build against a glibc 2.17 sysroot, so VAAPI is available
  wherever the app starts.
- **A gate holds the floor** (`scripts/glibc-floor.mjs`), on each freshly built
  addon and again in `afterPack` on the packaged files. It rejects any GLIBC
  version need above the floor and any strong unversioned import; the second
  rule catches a host-compiled C object (an unversioned `__isoc23_sscanf`
  passes a version check).
- Linux syscalls glibc added late are called through `libc::syscall`, not the
  wrapper (`renameat2` arrived in 2.28).
- `WEFTCUT_NATIVE_BUILD=1` is a local-only escape (host toolchain, per-addon
  gate skipped) for hosts where the legacy linker fails; packaging still
  enforces the floor.

## Consequences

- The floor no longer moves with the runner image; a regression is a red
  build, not a user report.
- C dependencies compile with the toolchain's GCC 4.8.5. If one needs a newer
  compiler, the fallback is building the addons in an `ubuntu:22.04`
  container (GCC 11, glibc 2.35) with the same gate.
- Newer glibc APIs are unavailable to Rust code by symbol name; each needs a
  raw syscall or a weak lookup.
- libva's compiled-in driver path leads with conda's build prefix, which does
  not exist on user machines; the search continues to the Debian/Ubuntu and
  Fedora/RHEL driver directories.
