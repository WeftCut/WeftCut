# macOS CI: a SIGKILLed VideoToolbox encoder hangs the next export

Diagnosis, 2026-10-29 to 2026-10-31. Question: why does macOS CI sometimes stall
from `export-resource-admission.spec.ts:71` onwards (the test that cancels an
export, then exports again)? **Cancel SIGKILLs the export's
`h264_videotoolbox` ffmpeg.** On the GitHub macOS VM the next VideoToolbox
session then never opens. Stopping ffmpeg gracefully (stdin EOF, SIGTERM,
SIGKILL only after 2 s) removed the hang in 20 of 20 repetitions.

## Probe and environment

- GitHub `macos-latest` arm64 runners: VMs whose VideoToolbox forwards to the
  host (ffmpeg logs `IOServiceMatchingfailed for: AppleM2ScalerParavirtDriver`).
  Not tried on a real Mac.
- Process-tree and `sample` probe started per app from the Playwright worker
  (`e2e/lib/macos-process-probe.mjs`), plus an ffmpeg-only spec
  (`e2e/electron/zz-vt-paravirt-probe.spec.ts`). Both are on the archived branch
  `diagnose/macos-vt-paravirt`.
- In-app runs: `export-resource-admission.spec.ts --grep=cancelling.bounded
  --repeat-each=N --retries=0`, one fresh runner each.

## What hangs

- The next export's ffmpeg blocks forever in `VTCompressionSessionCreate` →
  `VTParavirtualizationGuestSendMessageToHostAndCopyReplySync`, inside the
  first-use `pthread_once`. The host never replies. 0% CPU, sleeping.
- On one runner the app's hardware preview decoder blocked the same way, in
  `VTDecompressionSessionCreate` and `VTDecompressionSessionInvalidate`.
- The export never finishes, so quit raises the "export unfinished" dialog and
  the harness's graceful close times out. The VM stays degraded: later export
  tests stalled in preparation or could not close, and non-encoding tests
  passed. That cascade is why a leg ran 40–58 minutes.

## Results

In-app, cancel with:

| Stop | Run | Result |
| --- | --- | --- |
| SIGKILL | 40813984895 | hung on repetition 2 of 2 |
| SIGKILL | 41186870186 | hung on repetition 1 of 8 |
| SIGKILL | 41188126712 | hung on repetition 4 of 8 |
| stdin EOF, SIGTERM, SIGKILL after 2 s | 41188118685, 41191878589 | 20 of 20 passed |

3 of 7 SIGKILL repetitions hung. At that rate 20 passes by chance has
probability about 0.00001; at half the rate, about 0.008. A full CI leg runs the
test once, so CI failed only now and then (runs 40282180796, 40441674787,
41181885951).

ffmpeg alone, 40 rounds per mode: encode 1.5 s with VideoToolbox, stop, then
time a fresh 10-frame encode.

| Stop | Run | Fresh encode after the stop |
| --- | --- | --- |
| SIGKILL | 41186166047 | 25 × about 0.25 s, 15 × about 2.4 s |
| SIGKILL, another ffmpeg decoding with VideoToolbox | 41188134567 | 24 × about 0.25 s, 16 × about 2.4 s |
| `q` on stdin | 41186173835 | 40 × 0.21–0.34 s |

- No mode wedged the VM. A killed session is not released with the process: the
  host reclaims it about 2 s later. Something more in the app turns that into a
  permanent hang; candidates are frames in flight on stdin and the GPU
  process's own VideoToolbox decode. It was not isolated further, because a
  graceful stop avoids both.
