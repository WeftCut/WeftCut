import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");

// Where `npm run analyzer:build` lands the bin (dev profile). electron-ci runs
// that same script, so what CI prebuilds cannot drift from what a developer has.
const BIN = path.join(
  REPO,
  "apps/desktop/native/target/debug",
  process.platform === "win32" ? "media_conformance.exe" : "media_conformance",
);

// Default child-process deadline; per-leg override: WEFTCUT_ANALYZE_TIMEOUT_MS.
// Wide SSIM searches can need more: #37's 245-candidate call exceeded 600 s
// on Windows even after the export completed. Such callers pass timeoutMs
// explicitly; the ordinary calls keep this default. A deadline firing alone
// does not prove a wedge — the per-call logs show where the time went.
const TIMEOUT_MS = Number(process.env.WEFTCUT_ANALYZE_TIMEOUT_MS) || 600_000;

let warnedNoBin = false;

// Spawn the analyzer over `args` — the mode flags only; which binary and how to
// reach it is this module's business.
//
// LANDMINE — exec the bin, never `cargo run`. `cargo run` re-checks every unit's
// fingerprint before it hands over, and a miss compiles the bin at the dev
// profile's raised opt-level INSIDE whichever spec called first, with cargo's
// progress on the stderr this module discards on the happy path. That silence is
// what hid it: the first call cost ~10 min on the windows leg (~70-80 s on
// ubuntu/macOS) against a 0.4-3.6 s steady state, absorbed by a spec's own
// timeout and invisible in the job log. The bin is a build artifact like `out/`
// — rebuilding after a change to it is the caller's job, same contract.
function spawnAnalyzer(args, timeoutMs) {
  if (existsSync(BIN))
    return spawnSync(BIN, args, {
      cwd: REPO,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  if (!warnedNoBin) {
    warnedNoBin = true;
    console.warn(
      `[analyze] no analyzer at ${path.relative(REPO, BIN)} — falling back to \`cargo run\`, which compiles it inside this spec (minutes). Build it once with \`npm run analyzer:build\``,
    );
  }
  return spawnSync(
    "cargo",
    [
      "run", "--manifest-path", "apps/desktop/native/Cargo.toml",
      "--bin", "media_conformance", "--features", "jobs,export", "--quiet", "--",
      ...args,
    ],
    // Uncapped on purpose: this path's cost is COMPILATION, which TIMEOUT_MS is
    // not calibrated for. The warning above is the signal to fix it.
    { cwd: REPO, encoding: "utf8" },
  );
}

// Returns the parsed JSON report. The bin prints the report on stdout for exit 0
// (pass) AND 1 (regression); exit 2/3 (bad args / hard error) print only to
// stderr. So we parse stdout first and only throw when there's no parseable
// report. `mode` names the invocation in that error and nowhere else.
function runAnalyzer(mode, args, timeoutMs = TIMEOUT_MS) {
  const name = `media_conformance${mode ? ` ${mode}` : ""}`;
  // Cost drivers only: how deep the scan goes and how many candidates each
  // sample is matched against. Everything else in `args` is a path.
  const at = (flag) => (args.indexOf(flag) < 0 ? null : args[args.indexOf(flag) + 1]);
  const label = [mode || "ssim", `samples=${at("--samples") ?? at("--sample") ?? "-"}`]
    .concat(at("--window") ? [`window=${at("--window")}`] : [])
    .join(" ");
  // spawnSync blocks, so the opening line is the only thing a spec that dies
  // MID-analysis leaves behind: a start with no matching "took" is the analyzer,
  // and nothing else in the suite could say that. The pair also makes a slow
  // scan legible without profiling, which is how the cap above got calibrated.
  console.log(`[analyze] ${label} …`);
  const started = Date.now();
  const r = spawnAnalyzer(args, timeoutMs);
  console.log(`[analyze] ${label} took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  // A child that never ran, or that its deadline killed, reports in `error` while
  // `status` stays null — so this has to come before the parse, which would
  // otherwise blame an empty stdout for a process that was killed.
  if (r.error) {
    const why =
      r.error.code === "ETIMEDOUT" ? `exceeded ${timeoutMs}ms` : (r.error.code ?? r.error.message);
    throw new Error(
      `${name} did not complete (${why}${r.signal ? `, killed by ${r.signal}` : ""}): ${r.stderr ?? ""}`,
    );
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${name} exit ${r.status}: ${r.stdout}\n${r.stderr}`);
  }
}

export function analyze({ output, source, samples, ssimMin, audio, window, timeoutMs = TIMEOUT_MS }) {
  const args = [
    "--output", output, "--source", source, "--samples", samples.join(","),
  ];
  if (ssimMin != null) args.push("--ssim-min", String(ssimMin));
  if (window != null) args.push("--window", String(window));
  if (audio) args.push("--audio");
  return runAnalyzer("", args, timeoutMs);
}

// Self-SSIM: compare pairs of indices WITHIN one output video (no source).
// `samples` is read as consecutive pairs [a0,b0,a1,b1,...]. Returns the parsed
// `{ output, ssim_max, pairs:[{a,b,ssim,differ}], pass }`. Used by the motif-
// export e2e to prove an animated motif makes two output frames DIFFER (a
// skipped motif would render static black → near-identical → fail).
export function analyzeSelf({ output, samples, ssimMax }) {
  const args = ["--self-ssim", "--output", output, "--samples", samples.join(",")];
  if (ssimMax != null) args.push("--ssim-max", String(ssimMax));
  return runAnalyzer("--self-ssim", args);
}

// Windowed-RMS envelope assertions (fades / keyframed gain / limiter ceiling)
// against the deterministic Rust mixer's output. `expects` is
// [{ t_s, expect_rms_db_delta }] — deltas relative to the file's loudest
// 100 ms window. `peakMaxDb` additionally asserts the file's sample peak
// stays at/below the given dBFS (the alimiter ceiling check).
export function analyzeAudioEnvelope({ output, expects, peakMaxDb }) {
  const args = ["--audio-envelope", JSON.stringify(expects), "--output", output];
  if (peakMaxDb != null) args.push("--peak-max", String(peakMaxDb));
  return runAnalyzer("--audio-envelope", args);
}

// Whole-file per-channel RMS ratio vs the expected L−R dB delta (pan law).
export function analyzeAudioPan({ output, expectLrDb }) {
  return runAnalyzer("--audio-pan", [
    "--audio-pan", "--expect-lr-db", String(expectLrDb), "--output", output,
  ]);
}

// Gradient-row banding probe (--gradient-row): decode frame `sample` of
// `output` as 16-bit RGB under the FORCED `inMatrix`/`inRange` interpretation
// and report per-channel banding over the mid-row (the row is fixed at
// height/2 by the bin — the ramp fixtures vary along X only). Returns the
// parsed `{ sample, row_y, banding: [{distinct_levels, max_plateau} x3 RGB],
// probe_x0, probe_mid }`. No `pass` field — callers assert thresholds (the
// 10-bit ramp gate: distinct_levels > 600 of 1023). The bin's arg guard
// requires `--source` even though gradient mode reads only `--output`, so we
// satisfy it with the output path.
export function analyzeGradientRow({ output, sample, inMatrix, inRange }) {
  const args = [
    "--gradient-row", "--output", output, "--source", output,
    "--in-matrix", inMatrix, "--in-range", inRange,
  ];
  if (sample != null) args.push("--sample", String(sample));
  return runAnalyzer("--gradient-row", args);
}

export function analyzeColor({ output, source, manifest, inMatrix, inRange, sample }) {
  return runAnalyzer("--color", [
    "--color", "--output", output, "--source", source,
    "--manifest", manifest, "--in-matrix", inMatrix, "--in-range", inRange,
    "--sample", String(sample ?? 10),
  ]);
}
