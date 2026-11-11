---
status: accepted
---

# The stdio MCP entry is a native `weftcut` binary

Date: 2026-11-11

## Context

An agent's client reaches WeftCut over stdio through a shim that bridges to
the app's Streamable HTTP endpoint on loopback. The shim was a JS bundle run
on the app's own executable with `ELECTRON_RUN_AS_NODE=1`. That had four
costs:

- The packaged app had to leave Electron's RunAsNode fuse on, so any local
  program could run the app's executable as a general Node interpreter. The
  shim was the only part of the app that needed the fuse; every other child
  is a `utilityProcess`.
- Each agent session started a full Electron binary to relay messages.
- A client config named the executable, the script and two environment
  variables, all specific to one machine. Only the running app could write
  one, so a package distributed to many machines (an agent plugin) had
  nothing it could say.
- The shim forwarded a hand-written list of request methods. When the app's
  server gained `resources/templates/list`, the shim answered "method not
  found" for it for seven weeks.

The shim found the app through how it was started: `process.execPath` was the
app, and the config carried the profile directory. A separate binary has
neither.

Measured on macOS 26.5 (Apple Silicon, ad-hoc signed bundle), for how such a
binary may start the app:

- An executable path recorded earlier is dead after the bundle is moved.
  LaunchServices resolved the new location within 0.1 s.
- A bundle carrying `com.apple.quarantine` and opened where it was unpacked
  ran from an App Translocation mount; the mount was gone 8 s after quit, and
  spawning the recorded path failed. `open` started it again.
- Spawned directly, the app's responsible process (what the system attributes
  permission requests to) was the spawning chain. Started with `open`, the
  app was its own.
- With several bundles of the same id on the machine, `open -b` picked the
  one LaunchServices had launched last.

## Decision

- **One Go binary, `weftcut`**, written against the standard library alone
  and shipped in the app's resources. `weftcut mcp` is the stdio server; `info`,
  `print-config` and `list-tools` are the terminal helpers. With no argument
  it prints its help and starts nothing.
- **It passes messages through.** It reads a message's envelope (`id`,
  `method`) and forwards the rest untouched, in both directions. It answers
  itself only what must work while the app is closed, or what is the shim's
  own: `initialize`, `ping`, the two tools `weftcut_status` and
  `launch_weftcut` (merged into `tools/list`), and the answers of the down
  state. It keeps a table of requests in flight, so a lost app fails them at
  once and a reply that arrives after a timeout was answered is dropped; a
  tool call keeps its idle window, re-armed by progress.
- **The app session carries the client's identity.** The binary opens it
  after the client's `initialize`, with that client's name, version and
  capabilities and at the protocol version the client negotiated. Edits are
  attributed to the client, and the app sees the same client it would see
  over HTTP.
- **The app tells the binary where things are.** At every start the app
  copies the binary to `<userData>/cli/` and writes `launch.json` beside it:
  what to run to start this app again. The binary finds the profile from
  `WEFTCUT_USERDATA`, else from its own location under a profile's `cli/`,
  else the platform default; it finds the app from `WEFTCUT_APP`, else
  `launch.json`, else the app it is packaged inside.
- **macOS starts the app through LaunchServices**: `open -a` on the recorded
  bundle while that path exists, `open -b` on the bundle id otherwise.
- **A client config is that copy's path and `mcp`.** No environment, no
  script.
- **On Windows the binary is a GUI-subsystem program** that takes its
  parent's console when there is one. Measured on Windows 11: built as a
  console program and started with default flags by a `node.exe` that had no
  console, it was given a visible terminal window for as long as it ran. The
  JS shim never was, because it ran on the app's own GUI executable.
- **The RunAsNode fuse is off** in packaged builds, and the JS shim is gone.
- **A config written by an earlier release still works.** Started as
  `<app> <userData>/cli/weftcut-mcp.cjs`, the app opens no window and hands
  its stdio to `weftcut mcp`. Those configs sit in files the app does not
  own, so nothing else could move them.

Rejected:

- **The shim on npm** (`npx`). It needs Node on the user's machine and a
  second release channel whose version drifts from the installed app.
- **Rust**, which the workspace already builds, packages and gates. The
  program relays several streams at once under timers: in Rust that is an
  async runtime, an HTTP client and their dependency tree, each a line in the
  licence notices, and a glibc floor to hold on Linux. Go's standard library
  covers all of it and links statically. The price is a second native
  toolchain in the build.
- **A typed MCP SDK in the binary.** Forwarding by method is what drifted;
  a passthrough has no list of methods to keep.
- **Finding the app through OS registration alone** (registry, LaunchServices,
  desktop entries). An AppImage registers nowhere.

## Consequences

- The binary exists in a profile only after the app has run there once. A
  config comes from the running app's Connect panel, so a client never holds
  one before that.
- `weftcut` is not on `PATH`. A package that must name the command without a
  path has to wait for that.
- An AppImage that was moved is found again only after it is opened once
  from its new place.
- On macOS with several copies of the app and a stale `launch.json`,
  `open -b` may start a different copy than the one last used.
- The legacy hand-over keeps one Electron process alive per session of an
  old config, as before. That process boots as the app on the default
  profile, without the single-instance lock and without opening anything. It
  ends when those configs are replaced.
- A Windows terminal does not wait for a GUI-subsystem program. Typed at a
  cmd or PowerShell prompt, `weftcut info` prints after the prompt has
  returned and leaves no exit code; PowerShell loses the output outright when
  it is assigned or redirected (`$o = & weftcut …`, `> file`). A batch file,
  `cmd /c`, `| Out-String` and Git Bash wait and capture. The JS shim, on the
  app's GUI executable, behaved the same. A console twin of the binary would
  lift this; nothing needs one while the binary is not on `PATH`.
- The fuse is flipped at packaging, so an unpackaged run still honours
  `ELECTRON_RUN_AS_NODE`; only checks on the packaged app can see it off.
