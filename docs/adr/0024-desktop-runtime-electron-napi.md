---
status: accepted
---

# Desktop runtime: Electron + an in-process, stateless napi-rs core

Date: 2026-06-27

## Context

WeftCut ships on Windows, macOS and Linux. A system-webview runtime
(WebView2 / WKWebView / WebKitGTK) made codec, transport and capture behavior
diverge per OS, a recurring tax that blocked cross-platform parity. The heavy
runtime work (PixiJS WebGPU compositor, WebCodecs decode) already lives in the
web layer, and the domain core is Rust; rewriting it in Node was not an option.

A Rust-side read-mirror of the whole project, re-serialized on every commit
(drag bursts included) yet read rarely and mostly in slices, was a standing
synchronization liability: a second copy of state that could go stale and
attracted hand-mirrored twins.

## Decision

- The shell is **Electron**: one pinned Chromium on all three OSes.
- The Rust core is an **in-process napi-rs addon** (`@weftcut/core`,
  `apps/desktop/native/`), reached from main through
  `Backend.invoke(cmd, argsJson)` plus a thread-safe event callback; the
  renderer reaches main through the contextBridge preload. Not a separate
  process: control-plane calls stay sub-millisecond.
- **TypeScript owns all project state** (the main-process actor). Rust is
  project-state **stateless**: it keeps runtime slots (jobs, cache, workspace,
  logs, sessions), but every project compute or export call receives the exact
  `Project` / `MediaItem` slice it needs as an argument. No resident mirror.

## Consequences

- Renderer behavior is identical across OSes; offscreen-CDP Motif capture is
  byte-identical on the 3-OS determinism compare.
- Larger bundle and cold start; Chromium updates are ours to ship.
- A Rust feature that needs project data takes it in its request; a Rust-side
  project cache reintroduces the stale-mirror problem.
- Going out-of-process would make every compute call pay the state transfer
  across a process boundary.
