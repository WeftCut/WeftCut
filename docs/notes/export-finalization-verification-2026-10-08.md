# Export finalization and retry — Linux verification, 2026-10-08

Implemented on `fix/export-finalization-retry`, based on
`76c5642ad8be9b5eafdf369ba885d6f48603a815`. No commit or push was made.
This fixes the low-memory finalization finding in the
[original full verification](linux-full-verification-2026-10-08.md).

## Behavior

- Reserve the 64 MiB stream-copy tail before video production. Production borrows
  that same allowance and atomically returns it on release. No duplicate memory
  charge, and no CPU slot held while the tail is idle.
- A live, renderer-owned continuation can finish under ordinary RSS hysteresis.
  Critical host pressure and CPU exhaustion still reject an attempt. Native
  reservations survive until actual teardown, including owner death during mux.
- Produce audio before video; once encoding and encoder flush finish, retry uses
  immutable intermediate files and never re-encodes or rereads the project.
- Keep encoded files after mux failure. Offer Retry finishing export / Discard
  export. Performance settings preserve the pending retry. The error cannot be
  accidentally dismissed, and window close warns before discarding.
- Write a sibling temporary output, then replace the requested destination only
  after mux succeeds. Failures preserve an existing output. Expected audio that
  is missing causes an error, rather than silently producing a video-only file.
- Successful completion or explicit discard deletes encoded intermediates and
  releases the reservation. Retry is session-local; no crash/restart recovery is
  promised. See [ADR 0104](../adr/0104-export-finalization-retains-admission-and-encoded-files.md).

## Validation

| Check | Result |
| --- | --- |
| Original failing 2304 MiB 1080p export | Passed unchanged; 180 frames and image conformance |
| Original cancel then export again at 2304 MiB | Passed unchanged |
| Relevant Electron E2E | 14 distinct cases passed, one worker, no automatic retries |
| Full Vitest | 655 files; 8,937 passed, 3 existing Windows-only skips |
| Focused final TS regressions | 31 passed |
| Rust core / conformance analyzer | 661 / 20 passed; 4 existing opt-in tests ignored |
| TypeScript, Rust formatting, workspace all-target Clippy with warnings denied | Passed |
| React Doctor, including untracked source, compared with HEAD | No new diagnostics; 15 existing findings matched the baseline |
| Production build | Passed |
| Linux AppImage / deb packaging and packaged startup | Passed; fresh profile, native addons, new-project text preview |

The 14 Electron cases comprise seven resource-admission exports, two single-slot
exports, three finalization/file-protection cases, and two resource configuration
and IPC-boundary cases. These are targeted regression runs, not a repeat of the
entire 359-case Electron matrix from the original verification.

The actual retry test used the real native admission policy: the first two mux
attempts were forced into critical host pressure, and the third retained ordinary
RSS pressure. It completed with exactly **one video encode, one audio encode and
three mux attempts**, identical input paths/token on each attempt, both output
streams present, and image conformance passing. A separate two-failure/discard
case verified removal of both intermediates, exactly one reservation release and
preservation of the previous output. The settings round trip retained the same
pending export. The Chinese retry panel screenshot was inspected.

The first implementation charged a separate additional 64 MiB during production;
the original 2304 MiB tests caught that regression. The final implementation
transfers the allowance between sequential phases. The E2E hook also now checks
export error state: file existence alone falsely reported success when atomic
mux correctly preserved an older destination after a failed attempt.

## Memory and environment limits

The 10-second audio/video retry cases sampled process-tree RSS every 500 ms.
Peaks were **2617.0 / 2610.7 MiB** with a 2304 MiB configured target. This remains
a cooperative target, not a hard RSS ceiling; the patch fixes admission and lost
encoded work, not all Chromium allocator retention. The successful retry's last
sample was 1993.7 MiB with only the existing 12 MiB preview reservation remaining.
At the mux boundary, the ledger contained 76 MiB (64 MiB finalization plus 12 MiB
preview) and no CPU lease before/after each attempt.

Image conformance used the repository's existing Linux software-rendering values
`WEFTCUT_E2E_SSIM_FLOOR=0.62` and `WEFTCUT_E2E_COLOR_FAITHFUL_MAX=16`; memory targets,
assertions and timeouts were not raised. The NVIDIA driver mismatch found in the
original run remains an environment limitation. Windows/macOS were not executed.

React Doctor initially scanned 18 changed files (score 83), then 21 (score 77)
after the export-forwarding files were included. An explicit HEAD comparison
including new files confirmed **0 new / 0 fixed / 15 matched diagnostics**; the
changed scan population is not a comparable numeric before/after score.

Initial unrestricted-I/O tests run inside the execution sandbox failed on local
sockets/subprocesses; the complete Vitest rerun outside it passed. No application
assertions were relaxed for those setup failures.

## Evidence

Ignored artifacts: `apps/desktop/reports/export-finalization-2026-10-08/`.

- `e2e-transfer.json`: ten passes, with two new test-harness assertions subsequently
  corrected (old destination existence was mistaken for export success).
- `e2e-final.json`: five passes, including both corrected retry/discard cases and
  the two IPC/configuration cases. The atomic-file test appears in both runs.
- `retry-trace.json`, `discard-trace.json`: attempts, reservations, memory samples,
  input paths and production counts; screenshots under `e2e-final-artifacts/`.
- `weftcut-finalization-all-unit-verified.log`, `weftcut-finalization-all-rust.log`,
  final typecheck/Clippy/build logs and `weftcut-finalization-doctor.json`.

The refreshed AppImage and amd64 deb are in `apps/desktop/release/`. Native
library/licensing/skill packaging checks passed. `linux-unpacked/WeftCut` passed
isolated startup and new-project text-preview checks, without the E2E software
rendering flag; graphics still fell back to software with the known driver
mismatch. Packages were not installed or published. The builder's pre-existing
unset-`desktopName` warning remains. Checksums and metadata are in
`package-metadata.txt`; smoke JSON/screenshots/logs are in the same report folder.

No changes were made to the ProRes/Lite capability-probe finding or GPU drivers.
