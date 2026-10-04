---
status: accepted
---

# Motif local decoder Workers and WASM

Date: 2026-10-04

## Context

ADR 0079 made local resources portable but explicitly left Workers and WASM
disabled. This prevented common glTF Draco/KTX2 packages from loading even
though uncompressed glTF worked. Simply relaxing WASM compilation was also
insufficient: the bundled upstream Basis wrapper generates JavaScript with
`new Function` and fails under the Motif policy.

## Decision

Render pages add `worker-src 'self' blob:` and script
`'wasm-unsafe-eval'`. They retain the existing offline connections and resource
restrictions; ordinary `'unsafe-eval'` remains absent. Parameter pages do not
change. CSP, protocol path/origin confinement and Electron isolation remain
the security boundary.

The injected runtime exposes an awaitable setup phase. It tracks dedicated
Workers created during setup, limits the managed live set to eight, reports
worker errors and terminates that set on completion/failure or page exit.
SharedWorker and worker construction outside setup are unsupported. This
JavaScript lifecycle wrapper is a cooperative authoring contract, not a
security boundary against arbitrary author code. Worker clocks are not
virtualized; deterministic animation still belongs to synchronous `frame(t)`.

Main gives setup 30 seconds and normal frame/CDP commands 5 seconds. Capture
transport allows 60 seconds so it does not preempt initialization. Timed-out
hosts are destroyed. Setup errors identify their phase; content-failure
suppression continues to use the existing capture lane identity.

Ship an offline Three.js 0.186.1 template with GLTFLoader, DRACOLoader,
KTX2Loader and MeshoptDecoder. Its Basis JS/WASM pair is rebuilt from pinned
source using a pinned Emscripten container with `DYNAMIC_EXECUTION=0`; store
provenance, flags, hashes and licenses beside the bytes. Normal application
builds need neither Docker nor network for that pair. The template is included
with the agent skill and uses the same builder as the real codec tests.

Expose the existing validated ZIP importer as the app-scoped MCP `import_motif`
tool, returning `draft_id` without publishing. HTML authoring remains separate;
binary assets travel as a complete portable package.

## Consequences and validation

No CDN or preprocessing to uncompressed models is required for the supported
Draco/ETC1S/UASTC path. Decoder pools are initialization resources and must be
recreated on props changes. Large scenes that cannot initialize in 30 seconds
fail explicitly; this does not remove GPU memory limits.

Real Electron tests cover compressed geometry and both texture encodings,
image output, repeat/backward seeks, rebuilds, cleanup, missing/corrupt assets,
MCP import, offline Worker CSP and exported video. Unit tests cover phase
deadlines and host recovery. Existing package hashing covers every decoder
byte, so decoder changes invalidate captures along with other companions.

The general cross-machine pixel identity ambition in ADR 0017 is qualified for
GPU-rendered scenes: KTX2 transcodes to hardware-dependent formats and WebGL
results can differ across GPUs. We guarantee the absolute-time authoring
contract and test repeatability within the same environment. Cross-platform
CI remains necessary; a Windows validation is not evidence of a macOS/Linux run.
