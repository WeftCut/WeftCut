// How electron-ci spreads one e2e run across runners, and the one home for it.
// Three consumers read this file: the workflow's E2E step (through the `--shell`
// mode at the bottom), scripts/e2e-split.test.mjs (the gate against a spec that
// ends up on no runner, or on two), and scripts/run-e2e.mjs (`--slice=<name>`,
// which reproduces a CI leg locally).
//
// The split is PACKED, not maintained. Every spec file on disk is costed from
// the measured snapshot (timings.json, refreshed from a green run by
// scripts/e2e-timings-snapshot.mjs) and placed on the lightest leg, heaviest
// first — per OS, since a spec that costs 2 min on Linux is often 1 min on
// macOS. The three once-per-OS extras ride FIXED legs so the workflow's `if:`
// conditions can name them; they are placed before any spec, so the packing
// simply gives those legs fewer files. A spec the snapshot does not know is a
// new one and gets a default cost; it still lands on exactly one leg, because
// every leg of a commit packs the same directory listing against the same
// snapshot. Nothing here needs a hand-edit when a spec is added, removed or
// grows — only a snapshot refresh when the pack drifts out of balance, which
// scripts/e2e-split.test.mjs measures.
//
// What the one variable does to a run is playwright.config.ts (§WEFTCUT_E2E_ONLY),
// and the orthogonal per-PR/nightly tier split is e2e/README.md §Tiers.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = path.join(HERE, "electron");
export const SNAPSHOT_PATH = path.join(HERE, "timings.json");

/// Legs per OS, keyed by the `os:` matrix label — the `part:` matrix declares
/// the maximum and `exclude:` drops the rest per OS (asserted against this map
/// in scripts/e2e-split.test.mjs). Five is where the account's 20-job
/// concurrency cap puts the build/test phase (the budget note on the e2e job);
/// macOS has four because the cap allows 5 macOS jobs and `rust-test` is one.
/// With the pack balanced, a leg's wall clock is the OS total over its legs, so
/// buying a leg back from somewhere is the one way to shorten an OS further.
export const LEGS = {
  "windows-latest": 5,
  "ubuntu-latest": 5,
  "macos-latest": 3,
};

/// Specs an OS does not run, keyed by its `os:` matrix label. Only macOS has
/// an entry: it is the account's binding concurrency constraint (5 macOS jobs
/// across every repository), and most of the suite is renderer logic that
/// behaves identically under Chromium on every OS — Linux and Windows run it
/// in full. What macOS keeps is what only macOS can show: window chrome and
/// the traffic lights, the application menu, Keychain-backed storage,
/// notifications and shell integration, window geometry, the VideoToolbox and
/// Metal lanes, Motif capture on the GPU host, every @serial spec (the
/// determinism PNGs come from there), the per-OS ffmpeg build's codec matrix,
/// and the export conformance gates that only a real GPU holds to the strict
/// SSIM floor (electron-ci §WEFTCUT_E2E_SSIM_FLOOR). e2e/README.md
/// §How CI spreads one run across runners has the why.
///
/// Rules, asserted in scripts/e2e-split.test.mjs: a listed spec exists, is
/// listed once, has no @serial test (the serial project is never sliced and
/// would run it anyway), and is not one of the export-pressure suites, whose
/// platform coverage is a decision still open. Kept on macOS although they
/// would qualify: `smoke` (a per-platform smoke test is the point of one),
/// `caption-corpus` (the one end-to-end use of the Meta modifier),
/// `timeline-selection-focus` (branches on macOS Display P3), and
/// `model-settings`, `popup-overflow`, `role-mixer-audition` (each records a
/// failure first seen only on macOS).
///
/// The nightly @matrix sweep uses the same pack, so a spec here runs on macOS
/// only through a scoped dispatch (`inputs.e2e_args`), which is unsliced.
export const SKIP_ON = {
  "macos-latest": [
    // agent / MCP / TS-actor surfaces: SDK round-trips against the same
    // renderer state on every OS
    "agent-panel.spec.ts",
    "mcp-editing-workflow.spec.ts",
    "mcp-export.spec.ts",
    "mcp-flip.spec.ts",
    "mcp-motif.spec.ts",
    "mcp-server.spec.ts",
    "motif-workspace.spec.ts",
    "ts-actor-bringup.spec.ts",
    "ts-actor-flip.spec.ts",
    "ts-actor-motif-flip.spec.ts",
    "ts-actor-native-compute.spec.ts",
    // audio analysis in Web Audio / OfflineAudioContext: no device, no codec
    "audio-denoise.spec.ts",
    "audio-pan-preview.spec.ts",
    "audio-transport.spec.ts",
    "audio-waveform-alignment.spec.ts",
    // dock, panels, layout, theme
    "composition-scope.spec.ts",
    "composition-tabs.spec.ts",
    "dock-integration-acceptance.spec.ts",
    "dock-tab-overflow.spec.ts",
    "dock-workspace.spec.ts",
    "focus-regions.spec.ts",
    "history-panel.spec.ts",
    "layout-theme.spec.ts",
    "preview-canvas-layout.spec.ts",
    "property-panel.spec.ts",
    "search-palette.spec.ts",
    "shots-panel.spec.ts",
    // timeline editing
    "dragdrop.spec.ts",
    "group-media-pool.spec.ts",
    "group-render-nested.spec.ts",
    "group-timeline.spec.ts",
    "link-duplicate.spec.ts",
    "link-override.spec.ts",
    "link-visibility.spec.ts",
    "motion-path.spec.ts",
    "move-to-composition.spec.ts",
    "pauses.spec.ts",
    "playhead-restack.spec.ts",
    "subtitle-pool-drop.spec.ts",
    "time-remapping.spec.ts",
    "timeline-drop-strip.spec.ts",
    "timeline-layout.spec.ts",
    "timeline-markers.spec.ts",
    "timeline-marquee.spec.ts",
    "timeline-raise-to-strip.spec.ts",
    "timeline-ripple-delete.spec.ts",
    "timeline-split-delete-race.spec.ts",
    "track-reorder.spec.ts",
    // keyframes and transitions: preview and export compared against each
    // other, with the same assertions on every OS
    "keyframe-batch.spec.ts",
    "keyframe-color.spec.ts",
    "keyframe-conformance.spec.ts",
    "keyframe-effects.spec.ts",
    "transitions-wysiwyg.spec.ts",
    // group exports compared against their own exports
    "group-export-conformance.spec.ts",
    "group-export-nested.spec.ts",
    // text
    "text-box-cjk-export.spec.ts",
    "text-box-gizmo.spec.ts",
    "text-correction.spec.ts",
    "text-shadow.spec.ts",
    "text-tool.spec.ts",
    // media pool and protocols on identical fixtures
    "import-reopen.spec.ts",
    "media-gif-animated.spec.ts",
    "media-image-preview.spec.ts",
    "media-import.spec.ts",
    "media-protocol.spec.ts",
    "motif-library.spec.ts",
    "motif-params-page.spec.ts",
    "motif-protocol.spec.ts",
    // export plumbing that is not a codec or a GPU
    "export-presets.spec.ts",
    "export-repeat.spec.ts",
    "publication-protocol.spec.ts",
    // bridges and diagnostics with deterministic, host-independent output
    "driver-diagnostics.spec.ts",
    "edit-latency.spec.ts",
    "fs-guard.spec.ts",
    "ipc-handlers.spec.ts",
  ],
};

/// The leg each once-per-OS extra rides, fixed so that a workflow `if:` can
/// name it. `decodeBench` must ride with `serial`: the software-lane family
/// media it generates is read only by a @serial spec. Each must be a leg every
/// OS runs (so, within the smallest LEGS count). Serial and packaging are kept
/// apart so no leg carries both lumps.
export const CARRIERS = { serial: "e2e-1", decodeBench: "e2e-1", package: "e2e-2" };

/// What a spec the snapshot does not know is assumed to cost, in seconds of
/// test time per OS. Median-ish for this suite; a new spec's real cost enters
/// the pack at the next refresh.
export const DEFAULT_SECONDS = 30;

/// Conservative on purpose: `--shell` emits these names inside single quotes for
/// `eval`, so a quote character in one would run arbitrary shell on every runner.
const SPEC_NAME = /^[\w.-]+\.spec\.ts$/;

/// Every spec file the suite has, sorted.
export function specFiles(dir = SPEC_DIR) {
  const files = readdirSync(dir).filter((name) => name.endsWith(".spec.ts")).sort();
  for (const name of files) {
    if (!SPEC_NAME.test(name)) {
      throw new Error(`spec "${name}" is not a plain <file>.spec.ts, which the split cannot name safely`);
    }
  }
  return files;
}

/// The spec files one OS runs — the universe its pack covers.
export function specFilesFor(os, files = specFiles()) {
  const skipped = new Set(SKIP_ON[os] ?? []);
  return files.filter((file) => !skipped.has(file));
}

export function readSnapshot(file = SNAPSHOT_PATH) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/// `e2e-1` … `e2e-N`.
export function legNames(count) {
  return Array.from({ length: count }, (_, i) => `e2e-${i + 1}`);
}

/// The `part:` matrix values, in order: the widest OS's legs.
export function sliceNames() {
  return legNames(Math.max(...Object.values(LEGS)));
}

/// Which slices an OS runs, keyed by its `os:` matrix label. Derived from LEGS;
/// the workflow's matrix `exclude:` is the other half of the same fact.
export const OS_SLICES = Object.fromEntries(
  Object.entries(LEGS).map(([os, count]) => [os, legNames(count)]),
);

/// `process.platform` to the `os:` matrix label, so a local replay resolves to the
/// same pack as the leg it is reproducing. A machine can only reproduce its own
/// OS's legs, which is why this is derived rather than passed.
const MATRIX_OS = { win32: "windows-latest", linux: "ubuntu-latest", darwin: "macos-latest" };

/// The matrix label for a platform. Throws rather than defaulting: guessing here
/// would pack for the wrong OS, and a leg running the wrong share while reporting
/// green is the failure class this module exists to make impossible.
export function osLabelFor(platform = process.platform) {
  const os = MATRIX_OS[platform];
  if (!os) {
    throw new Error(`no e2e slice set for platform "${platform}" — CI runs ${Object.values(MATRIX_OS).join(", ")}`);
  }
  return os;
}

/// A spec's cost on one OS in seconds of leg wall clock: the snapshot's summed
/// test time, or the default for a spec the snapshot has not measured. Summed
/// test time IS wall clock here, on every OS: the measured legs never ran two
/// tests at once — not even macOS, which then declared two workers
/// (run 40287526652: 38.0 min of test time in a 38.7 min leg, zero overlap). So
/// the extras' wall clocks add to it directly.
export function specSeconds(file, os, snapshot) {
  return snapshot.seconds.parallel[file]?.[os] ?? DEFAULT_SECONDS;
}

/// Pack one OS's legs. Deterministic: extras first on their fixed legs, then
/// every spec heaviest-first onto the currently lightest leg (ties to the lowest
/// index, then by name), which is the classic longest-processing-time rule and
/// lands within a few percent of optimal for this many small items.
export function pack(os, { files, snapshot = readSnapshot() } = {}) {
  const count = LEGS[os];
  if (!count) {
    throw new Error(`unknown OS "${os}" — expected one of ${Object.keys(LEGS).join(", ")}`);
  }
  files ??= specFilesFor(os);
  const bins = legNames(count).map((name) => ({
    name,
    own: [],
    seconds: 0,
    serial: CARRIERS.serial === name,
    decodeBench: CARRIERS.decodeBench === name,
    package: CARRIERS.package === name,
  }));
  for (const [extra, legName] of Object.entries(CARRIERS)) {
    const bin = bins.find((b) => b.name === legName);
    if (!bin) {
      throw new Error(`the \`${extra}\` carrier ${legName} is not a leg ${os} runs — carriers must be legs every OS runs`);
    }
    const seconds = snapshot.seconds[extra]?.[os];
    if (seconds === undefined) {
      throw new Error(`timings.json has no \`${extra}\` cost for ${os}`);
    }
    bin.seconds += seconds;
  }
  const items = files
    .map((file) => ({ file, seconds: specSeconds(file, os, snapshot) }))
    .sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : 1));
  for (const item of items) {
    const lightest = bins.reduce((best, bin) => (bin.seconds < best.seconds ? bin : best), bins[0]);
    lightest.own.push(item.file);
    lightest.seconds += item.seconds;
  }
  for (const bin of bins) bin.own.sort();
  return bins;
}

const packed = new Map();

/// The legs one OS runs, packed, in `part:` order. Memoised per OS: the pack is
/// a pure function of the directory listing and the snapshot, both fixed for a
/// process's lifetime.
export function slicesFor(os) {
  if (!packed.has(os)) packed.set(os, pack(os));
  return packed.get(os);
}

/// The variable playwright.config.ts consumes, for one leg on one OS. Every way
/// a caller can disagree with the pack throws, because each of them is a leg
/// doing the wrong amount of work while still reporting green: an unknown slice
/// name or OS label would leave an empty restriction, under which that one
/// runner repeats the whole suite, and a slice the named OS does not run is a
/// `part` the matrix should have excluded rather than a leg to skip.
export function sliceEnv(name, os) {
  if (!LEGS[os]) {
    throw new Error(`unknown OS "${os}" — expected one of ${Object.keys(LEGS).join(", ")}`);
  }
  const slice = slicesFor(os).find((s) => s.name === name);
  if (!slice) {
    throw new Error(
      sliceNames().includes(name)
        ? `e2e slice "${name}" is not one ${os} runs (${OS_SLICES[os].join(", ")}) — exclude that part from the matrix instead`
        : `unknown e2e slice "${name}" — expected one of ${sliceNames().join(", ")}`,
    );
  }
  if (slice.own.length === 0) {
    throw new Error(`e2e slice "${name}" on ${os} owns no spec file — an empty restriction would run the whole suite`);
  }
  return { WEFTCUT_E2E_ONLY: slice.own.join(",") };
}

/// How far the snapshot has drifted from the directory: specs on disk it has not
/// measured, and entries for specs no longer on disk. Both are harmless to the
/// pack (default cost; ignored) and both are the signal to refresh it.
export function snapshotDrift({ files = specFiles(), snapshot = readSnapshot() } = {}) {
  const known = new Set(Object.keys(snapshot.seconds.parallel));
  const onDisk = new Set(files);
  return {
    unmeasured: files.filter((file) => !known.has(file)),
    stale: [...known].filter((file) => !onDisk.has(file)),
  };
}

/// `node e2e/slices.mjs --shell <part> <os>` → one assignment for `eval`, which
/// is how the pack reaches electron-ci's E2E step. Both matrix dimensions, since
/// the pack is per OS.
///
/// A shell variable and NOT $GITHUB_ENV: the step exports it in a subshell around
/// the parallel Playwright invocation only. Written to $GITHUB_ENV it would reach
/// the serial run too, narrowing the serial project to this leg's files — the
/// @serial tests mostly live elsewhere, and Playwright kills the whole leg with
/// "No tests found" before a spec runs.
function shellAssignment(name, os) {
  const { WEFTCUT_E2E_ONLY } = sliceEnv(name, os);
  return `OWN='${WEFTCUT_E2E_ONLY}'\n`;
}

/// `node e2e/slices.mjs --table` → the pack per OS with its costs, for a human
/// checking the balance.
function table() {
  const lines = [];
  for (const os of Object.keys(LEGS)) {
    lines.push(`${os}:`);
    for (const bin of slicesFor(os)) {
      const extras = ["serial", "decodeBench", "package"].filter((flag) => bin[flag]);
      lines.push(
        `  ${bin.name}  ${(bin.seconds / 60).toFixed(1).padStart(5)} min  ${String(bin.own.length).padStart(3)} files${extras.length ? `  +${extras.join("+")}` : ""}`,
      );
    }
  }
  for (const [os, skipped] of Object.entries(SKIP_ON))
    lines.push(`${os} skips ${skipped.length} specs (SKIP_ON)`);
  const drift = snapshotDrift();
  if (drift.unmeasured.length) lines.push(`unmeasured (default cost): ${drift.unmeasured.join(", ")}`);
  if (drift.stale.length) lines.push(`stale snapshot entries: ${drift.stale.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf("--shell");
  const [part, os] = flag === -1 ? [] : process.argv.slice(flag + 1, flag + 3);
  if (process.argv.includes("--table")) {
    process.stdout.write(table());
  } else if (!part || !os) {
    console.error(
      `usage: node e2e/slices.mjs --shell <${sliceNames().join("|")}> <${Object.keys(LEGS).join("|")}>\n       node e2e/slices.mjs --table`,
    );
    process.exitCode = 1;
  } else {
    // A disagreement throws out of here: nothing reaches stdout, so the caller's
    // `$(…)` assignment fails instead of eval'ing an empty restriction.
    process.stdout.write(shellAssignment(part, os));
  }
}
