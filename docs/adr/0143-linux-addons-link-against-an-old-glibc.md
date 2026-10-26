---
status: accepted
---

# Linux addons link against an old glibc

Date: 2026-10-27

## Context

The Linux package failed to start on Ubuntu 22.04 (issue #73):
`@weftcut/core` needed GLIBC_2.38 and GLIBC_2.39. The addons were built on
`ubuntu-latest`, so their glibc floor was whatever that runner image shipped,
and it would have risen again with the image's move to 26.04. The rest of the
package was never the problem: Electron 44 needs glibc 2.25 and the BtbN
libav* set 2.28.

The 2.38 symbols (`__isoc23_sscanf`, `__isoc23_strtol`) came from aws-lc-sys,
the C crypto library behind rustls, compiled by the runner's C23-default gcc.
The 2.39 ones were Rust std's `pidfd_*`. Patching symbols one at a time (PR
#74) cannot keep up with either; only building against an older glibc can.

## Decision

- **Both addons link against napi-rs's glibc 2.17 cross toolchain**
  (`napi build --use-napi-cross`) on Linux x64, in the same npm scripts a
  developer runs (`scripts/napi-linux-sysroot.mjs`). The C compilers are
  passed under cc-rs's per-triple names, because cc-rs ignores `TARGET_CC`
  when target and host triples match and would otherwise fall back to the
  host gcc.
- **The package promises glibc 2.28**, the highest need among the files that
  must load for the app to start. The bundled libva (2.38) is outside it:
  ffmpeg loads it lazily for the optional VAAPI lane, and an older glibc
  costs only that lane.
- **A gate holds the floor** (`scripts/glibc-floor.mjs`), run on each freshly
  built addon and again in `afterPack` on the packaged files. It rejects any
  GLIBC version need above the floor and any strong unversioned import; the
  second rule catches a host-compiled C object, which leaves an unversioned
  `__isoc23_sscanf` that a version check alone passes.
- Our own code calls Linux syscalls glibc added late through `libc::syscall`
  rather than the wrapper (`renameat2` arrived in 2.28).

## Consequences

- The floor no longer moves with the runner image, and a regression is a red
  build rather than a user report.
- The C dependencies are compiled by the toolchain's GCC 4.8.5. If a future
  dependency needs a newer C compiler, the fallback is building the addons in
  an `ubuntu:22.04` container (GCC 11, glibc 2.35); the gate stays as it is.
- Newer glibc APIs are unavailable to Rust code by symbol name; each needs a
  raw syscall or a weak lookup instead.
- On glibc below 2.38 the app decodes in software where it would have used
  VAAPI. Building libva from source against the same sysroot would lift that.
