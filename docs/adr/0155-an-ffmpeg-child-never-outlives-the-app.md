---
status: accepted
---

# An ffmpeg child never outlives the app

Date: 2026-11-01

## Context

The owner in `native/src/ffmpeg/child.rs` (PR #112) stops a child gracefully:
stdin EOF, SIGTERM, 2 s, then SIGKILL. A SIGKILLed VideoToolbox encoder had
been wedging the macOS CI VM
([note](../notes/macos-runner-videotoolbox-kill-2026-10-31.md)). A dropped
owner sends the SIGTERM at once and leaves the SIGKILL to a background thread.

That thread dies with the app. After #112, main runs 41206394144 and
41208234550 failed on macOS: ProRes specs timed out on "Electron graceful
close". Reproduced on `diagnose/macos-prores-close-hang` (run 41224796328,
full `--slice=e2e-1`). Electron had exited. Its `-hwaccel videotoolbox` proxy
transcode of the ProRes fixture was left orphaned (ppid 1): the decode threads
waited in `VTParavirtualizationReplyClerkWaitForReply`, and the main thread in
`sch_stop → pthread_join`. SIGTERM cannot end that process; only SIGKILL can,
and nothing was left to send it. Before #112, `kill_on_drop` sent SIGKILL
inside the drop. The orphan kept the test runner's close waiting until the
harness killed it. Once a VM's VideoToolbox ProRes decode wedged, every later
ProRes spec on that leg failed the same way, retries included.

An app killed outright (crash, SIGKILL, Task Manager) leaves every running
child behind in the same way, wedged or not. A transcode writing to a file
does not notice its parent is gone and runs to the end.

## Decision

**Every ffmpeg / ffprobe child is handed at spawn to something outside the app
that ends it when the app dies, however the app dies** (`native/src/ffmpeg/guard.rs`).
It is taken back when its owner drops the reaped process.

- **macOS and Linux: the reaper.** `weftcut-reaper` (`native/reaper`, libc
  only, ~0.5 MB) ships beside the core addon. The addon finds it next to its
  own `.node` and starts one with the first child. It keeps only the write end
  of the reaper's stdin and sends `+<pid> <start time>` / `-<pid>` lines. The
  kernel closes that pipe however the app exits. On EOF the reaper runs the
  owner's stop for every child still held: SIGTERM, `STOP_GRACE`, SIGKILL.
  The start time is checked before every signal, so a reused pid is never
  hit. The reaper ignores SIGINT, SIGHUP and SIGTERM, which the app's
  process group may receive with the app. It closes inherited descriptors and
  holds none of the app's stdio. If it dies, the addon starts another and
  re-sends every child.
- **Windows: a job object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The
  handle is created once, never inherited and never closed, so the app's exit
  closes it and the kernel kills whatever is left. Windows has no SIGTERM, and
  the owner would have killed the child too.
- **Normal quit and abnormal exit take the same path.** Quit does not wait for
  children. The in-process owner still stops each child and runs the watchdog
  while the app lives.
- `napi:build` builds the reaper with the addon's toolchain (the glibc 2.28
  sysroot on Linux). The Rust artifact cache carries it. electron-builder
  unpacks it beside the addon. afterPack refuses a macOS or Linux package
  without an executable reaper, and holds it to the glibc floor.

## Consequences

- One more small process per app on macOS and Linux, idle on a pipe.
- An app that is killed (or exits) with a child wedged in a hardware session
  takes up to 2 s more to leave no trace, and the trace never stays.
- If the reaper is missing in a dev build, the addon logs a warning and
  children are unguarded. A package cannot ship that way.
- `e2e/electron/ffmpeg-orphans.spec.ts` kills the app mid-export on every OS
  and requires the encoder to end.

Rejected:

- A synchronous sweep in `before-quit`: it covers only a normal quit.
- Linux `PR_SET_PDEATHSIG`: it fires when the spawning thread exits, and
  tokio retires idle blocking threads after 10 s.
- A wrapper process per child: it doubles the processes and complicates
  stdio, the watchdog's CPU sampling and signal forwarding.
- A sweep at the next launch: it leaves orphans until then.
