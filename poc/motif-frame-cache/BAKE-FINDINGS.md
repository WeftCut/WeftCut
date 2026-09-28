# Motif baking: PNG removal and capture reuse

This experiment changes no production source or installed addon. Its scope is
the PNG intermediate in baking and reuse of an already requested/cached frame.
It does not test host pools, grouping Motifs, larger batches, frame-rate changes,
or alternative idle scheduling.

## Measured result — 2026-09-28

**Native GPU readback is a useful PNG-free bake path on this machine. Sending
uncompressed RGBA over ordinary renderer/main IPC is not a general replacement.**

Windows, Electron 44.1.1, Intel i5-13400, RTX 3050 OEM. The post-run Electron
GPU-info snapshot identifies NVIDIA/ANGLE D3D11 as the active renderer
(driver 32.0.16.1060); both early and post-run snapshots are in the evidence.
These are synthetic, isolated-process measurements on one machine, not a
cross-hardware or real-project throughput guarantee.

Mean complete-bake elapsed time divided by frames, across three 20-frame runs:

| Fixture | PNG baseline | RGBA IPC | Native readback | Native time reduction |
|---|---:|---:|---:|---:|
| 480×270 overlay | 33.5 ms/frame | 33.7 ms/frame | 33.3 ms/frame | 0.5% |
| 480×270 dense Canvas | 38.1 ms/frame | 33.1 ms/frame | 33.9 ms/frame | 11.1% |
| 1920×1080 overlay | 62.1 ms/frame | 67.2 ms/frame | 50.3 ms/frame | 18.9% |
| 1920×1080 dense Canvas | 169.8 ms/frame | 86.9 ms/frame | 76.6 ms/frame | 54.9% |

There is run-to-run variation: 1080p overlay round means range from 51.9–68.2
ms/frame for PNG and 43.9–59.2 for native; dense Canvas ranges are 163.4–175.5
and 69.2–80.9 respectively. The small-overlay difference is effectively a tie.

Small/simple frames remain near the capture/settling cost. In the 1080p overlay,
RGBA IPC is **8.2% slower** than PNG. It sends 8.29 MB/frame instead of a small
compressed image. Its persistence round trip averages 21.6 ms versus 8.1 ms for
PNG; these durations include native encoding and file writes, so they are not
pure IPC timings. Native readback avoids that full-frame renderer/main transfer.

Selected 1080p phase means (nested spans; do not add every column together):

| Phase | Overlay | Dense Canvas |
|---|---:|---:|
| PNG Canvas encoding + Blob extraction | 14.3 ms | 81.8 ms |
| PNG native decode + LZ4 encoding call | 6.1 ms | 39.4 ms |
| RGBA Canvas draw/readback | 7.8 ms | 8.8 ms |
| Native staging readback | 5.3 ms | 5.2 ms |
| Native channel conversion/unpremultiply | 3.0 ms | 10.6 ms |
| Native LZ4 + header/hash encoding | 2.7 ms | 14.8 ms |
| Native atomic write wrapper | 1.6 ms | 4.7 ms |

The PNG-versus-native capture durations also vary with pacing and browser frame
alignment; the overall difference is not simply the sum of removed codec costs.
File sizes stayed essentially equal across paths: about 51.6 KB/frame for the
1080p overlay and 7.69 MB/frame for the dense stress fixture.

Reuse results, 36 frames per row across three rounds:

| Controlled scenario | Current capture count per frame | Candidate count | Current completion | Candidate completion |
|---|---:|---:|---:|---:|
| Cold, simultaneous preview + prewarmer + baker | 3 | 1 | 102.0 ms | 65.8 ms |
| Already in L0, incremental bake work | 1 | 0 | 63.0 ms | 28.3 ms |

Warm-case raw logs include the initial L0 fill: 24 versus 12 captures per
12-frame round, of which 12 in each path are the untimed initial fill. The
candidate reduces measured completion time by 35.5% in the cold-overlap case
and 55.0% in the warm case. Clone overhead is included. These are constructed
overlaps, not a promise that every project will gain those percentages.

All 480 persisted candidate frames passed exact premultiplied-byte comparison
against their PNG counterparts. Alpha was identical. Raw straight RGB differed
by at most one, with repeated runs giving identical sequences. All 192 sampled
rendered comparisons passed with **zero differing channels** through GPU/CPU
readback and four backgrounds.

The final command exited 0. Raw local evidence:
`.scratch/motif-bake-1790577423119/result.json`. A portable extract of timings,
per-round results, capture counts and conformance checks is checked in as
[`bake-results.json`](bake-results.json). Earlier quick/preliminary runs are not
the source of the table above. The final harness uses FrameStore's zero-copy
Buffer view, avoiding an extra benchmark-only payload copy. Electron logged a
GPU-context teardown diagnostic after writing the passing result; no capture,
pixel check or measured bake failed.

## Reproduce

From the repository root on Windows, with dependencies and the existing core
addon built:

```sh
node poc/motif-frame-cache/bake-run.mjs --quick
node poc/motif-frame-cache/bake-run.mjs
```

The runner builds an isolated release addon offline from the checked-in lockfile,
then launches an isolated Electron process. It disables the optional sccache
wrapper for this build. Nothing replaces `apps/desktop/native/index.*.node`.
The addon, profile, bundled source, frames and full `result.json` are under
`.scratch/`. Each run has a new directory and every timed bake has a fresh L2
address. Compilation completes before any timing starts.

The full run has two synthetic fixtures at 480×270 and 1920×1080, three rounds,
20 frames per path per round (720 timed baked frames), and three excluded warmup
frames per path/fixture/size. Path order rotates each round. `overlay` contains
text, shadows, rounded edges, CSS animation and translucent Canvas drawing.
`dense` additionally updates deterministic high-entropy Canvas pixels, including
all 256 alpha values; it is a stress fixture, not a typical title.

The actual production `MotifBaker`, `MotifFrameCache`, capture host, deterministic
runtime, `MotifGpuTransport`, preload MessagePort receiver, PNG encoder, LZ4 file
codec and atomic file replacement are reused. The baker still uses batch size 1
and `requestIdleCallback(..., {timeout: 200})`. Complete-bake time includes disk
existence checks, capture, delivery, persistence, L0 insertion and idle gaps.
Every path must make exactly one capture per frame and leave every frame in L0.
The isolated harness substitutes the workspace getter and IPC dispatch; it is
not a full-editor playback/export benchmark.

## The three paths

| Path | What is timed |
|---|---|
| PNG baseline | OSR → production GPU transfer → ImageBitmap → production Canvas PNG encoder → ordinary IPC → production PNG decode/LZ4 encode → atomic write → L0 warm |
| RGBA IPC | Same capture and GPU delivery → Canvas getImageData → ordinary RGBA IPC → native production LZ4 encode → atomic write → L0 warm |
| Native | Same OSR capture → native D3D11 staging readback → BGRA/RGBA normalization and unpremultiply → production LZ4 encode → atomic write → production GPU delivery → ImageBitmap/L0 warm |

Native readback uses one persistent worker/device and a staging texture reused
at a stable size. It respects row pitch and the source keyed mutex, and finishes
reading before the capture surface is released. It still transfers a bitmap to
the renderer and populates L0, so it does not win by omitting preview warming.
No concurrent capture/write pipeline is introduced. The experiment only handles
Windows RGBA8/BGRA8; production fallbacks, device-loss recovery, adapter selection
and shutdown/timeout hardening would be subsequent implementation work.

## Pixel checks

All verification runs **after all timing**, to keep its image readbacks and
decoding allocations out of later timed rounds.

- Decode every persisted candidate frame with the production reader, compare
  dimensions, straight RGBA, alpha, and the exact premultiplied bytes produced
  by the production GPU upload formula.
- Verify that every sequence contains distinct frames and each candidate's
  complete sequence is byte-identical across repeated rounds.
- Read three frames per size/fixture/candidate through both the production GPU
  disk reader and CPU fallback. Composite onto transparent, black, white and
  colored backgrounds and compare exact Canvas output bytes (192 comparisons).

Straight-alpha RGB bytes need not be identical to the PNG baseline: integer
unpremultiplication can choose adjacent values that map back to the same
premultiplied channel. The report records those differences separately; they
are not silently classified as raw-byte equality. A run fails if alpha differs,
the raw difference exceeds one, **any premultiplied channel differs**, or any
of the rendered comparisons differs. This is stronger than a visual/SSIM check,
but does not establish other hardware, float16 export, effects or transforms.

## Capture reuse experiment

Three rounds of 12 changing 1080p overlay frames drive the real baker and
prewarmer plus a preview requester. The controlled cold case requests each
frame simultaneously from all three; the warm case first seeds L0, outside the
timed region. Both use the same RGBA persistence path, so this isolates reuse
from PNG removal. It is an overlap experiment, not a measurement of the overlap
frequency in a user's actual project.
Both reuse variants schedule zero-delay callbacks to force that overlap; their
completion times do not include the full editor's idle scheduling or compositing.

The candidate checks L0 and an in-flight map keyed by `(cacheKey, frame)`.
Capture results enter the real cache. Each caller receives an owned
`createImageBitmap` clone while the canonical bitmap is pinned, preserving the
existing caller contracts: the prewarmer may close an obsolete result and the
baker may close a result after a failed write. Clone cost is included.
The map removes settled failures as well as successes. Expected capture counts
are asserted rather than inferred from time.

## Implementation seam suggested by the experiment

1. Put committed-frame acquisition in a shared broker used by sprite, prewarmer
   and baker. Key by the full existing descriptor/cache key plus content frame;
   keep transient parameter-preview frames in their separate lane. Check L0
   before creating a capture, and join identical in-flight captures.
2. Return an explicit `{bitmap, release}` lease if changing the caller contracts.
   The broker/cache owns the canonical bitmap; consumers release their lease,
   never close another consumer's object. Release on write failure, cancellation,
   stale completion and disposal. The clone-based probe is a compatibility
   prototype, not a complete broker implementation.
3. Keep persistence authorized by the baker and deduplicate it independently.
   Mark disk progress only after atomic replacement succeeds. A joined preview
   request must retain current high-priority/latest-wins behavior without
   cancelling work still needed by a baker or another consumer. This requires
   subscriber-aware cancellation/priority, not merely caching one promise.
4. For a newly captured frame that needs baking, persist from the native surface
   while it is leased. An already cached renderer ImageBitmap does **not** retain
   the original OSR surface: capture currently releases it after copying into
   the transport pool. Joining a capture and saving a long-finished L0 frame are
   therefore different cases. The latter needs bitmap readback or a separately
   budgeted native pixel cache; this benchmark does not justify an unbounded
   second cache. Retaining the existing PNG write fallback for L0 hits is also
   a reasonable incremental option if RGBA IPC costs more.

PNG removal and capture reuse were measured separately. Their speedups must not
be multiplied; these figures do not measure the combined editor implementation.

## Production integration

The editor now uses the native OSR encoder with the unchanged `.wfrm` format,
and a subscriber-aware frame broker with owned bitmap clones. Unlike this
isolated prototype, the production broker lets consumers publish into L0 only
after their stale checks. A joining bake can attach a write while the capture
renders; L0 hits and late joins retain PNG persistence without recapture.

`apps/desktop/e2e/electron/motif-bake.spec.ts` exercises the production app and
addon on the same Windows machine. Four 30-frame cases passed:

| Case | Native encode calls | PNG encode calls | Result |
|---|---:|---:|---|
| Fresh GPU bake | 30 | 0 | 30 readable `.wfrm` frames |
| Forced PNG capture | 0 | 30 | 30 readable `.wfrm` frames |
| Injected native readback failure | 1 failed | 30 | Compatibility writer completes |
| Fully warmed L0 before bake | 0 | 30 | No additional capture calls |

The fresh-bake counts above describe one observed run. Scheduling can let the
prewarmer finish some frames first; those use the L0 compatibility writer
(another run used 10 native writes and 20 PNG writes). The test requires native
work to occur and exactly one successful write per frame, rather than promising
that every editor bake is PNG-free.

All cases check transparent and partially transparent pixels. Unit tests cover
joining persistence, write failures, subscriber cancellation, clone ownership,
workspace binding/reset and queue promotion. Rust tests exhaustively check
the alpha round trip over all valid 8-bit premultiplied channel values.
