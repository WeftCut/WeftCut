// The empirical performance numbers of the Motif frame path, each with its
// default and the range an override may take (docs/motifs.md#tuning), and the
// protocol deadlines, which are not overridable. Correctness values (sizes,
// formats, markers) live in `limits.ts`, `frameMarker.ts` and the native core.
// Main resolves the overrides once (`src/main/motif/tuning.ts`) and hands the
// result to every process that runs Motif code.

const MIB = 1024 * 1024

interface TuningKey {
  default: number
  /** Inclusive integer bounds an override must fall within. */
  range: readonly [min: number, max: number]
}

/** "Measured" names the machine and the record; "not measured" means the
 * default was chosen, not swept. Every machine named is the Windows bench
 * (Windows 11, i5-13400 with 16 threads, RTX 3050) unless it says otherwise. */
export const MOTIF_TUNING_SPEC = {
  /** Capture hosts open at once, each showing one Motif content version, at a
   * renderer process and a capture surface each. Measured on the bench and an
   * M1 8 GB (ADR 0161): with 2, two stacked Motifs went from 1.6–3.7 fps per
   * lane to 10–30, and the M1 stayed at normal memory pressure without swap
   * growth; one Motif never opens a second host. More than 2 is not
   * measured. */
  captureHosts: { default: 2, range: [1, 4] },
  /** Frames a capture host renders while earlier ones are still on their way
   * to a paint; the bake coordinator keeps as many in the capture queue.
   * Measured: ADR 0159; 5 in flight gained about 2% on a 4K bake
   * (docs/notes/motif-bake-write-path-2026-11-08.md). */
  framesInFlight: { default: 3, range: [1, 8] },
  /** The capture host's paint rate (Hz) while frames are in flight. Measured:
   * 240 Hz gained nothing over 60 or 120 (docs/notes/motif-capture-frame-id-2026-11-08.md,
   * motif-bake-write-path-2026-11-08.md). */
  captureFrameRate: { default: 120, range: [30, 240] },
  /** Renders of a frame the compositor skipped before it fails. Not measured. */
  skippedFrameRetries: { default: 3, range: [0, 10] },
  /** How long a background capture waits before it gets one frame between
   * foreground ones (ms). Not measured. */
  backgroundAgingMs: { default: 2000, range: [100, 60_000] },
  /** How long a capture whose Motif has no capture host lets younger captures
   * of its class whose Motif has one go first (ms); 0 keeps arrival order.
   * Not measured. */
  hostAffinityMs: { default: 250, range: [0, 10_000] },
  /** How long expected frames may go without a paint before the capturer is
   * restarted (ms). Not measured; one new window once sent no paint for 1.5 s
   * (docs/notes/motif-capture-frame-id-2026-11-08.md). */
  stallNudgeMs: { default: 200, range: [50, 5000] },
  /** Stored frames holding pixels between capture and disk. Measured: ADR 0158;
   * 4 slots gained 1–3% on a 4K bake (docs/notes/motif-bake-write-path-2026-11-08.md). */
  writeSlots: { default: 2, range: [1, 8] },
  /** Stored-frame reads in flight per document, which is also the renderer
   * scheduler's disk-read slots. Measured on the bench and an M1 8 GB:
   * ADR 0154, docs/notes/motif-texture-read-path-2026-11-06.md. */
  readsInFlight: { default: 3, range: [1, 8] },
  /** `ahead` and `background` captures one renderer document keeps in main's
   * capture queue; `current` captures are never held back. Measured on the
   * bench and an M1 8 GB (ADR 0161): keeping 2 lookahead captures outstanding
   * doubled uncached heavy DECO Motifs (M1 12→30 fps, a mid-weight one on the
   * bench 17→30); 3, or `framesInFlight` 5, added nothing but queueing in
   * main. Each request sent must reach a host within `captureTransportMs`,
   * and may be stale after a seek. */
  captureRequests: { default: 2, range: [1, 32] },
  /** Texture-lane uploads main runs at once. Measured with three reads in
   * flight (docs/notes/motif-texture-upload-2026-11-07.md); other counts not
   * measured. */
  gpuLanes: { default: 3, range: [1, 8] },
  /** How long a texture-lane read waits for GPU budget before it answers
   * `unavailable` (ms). Not measured. */
  gpuBudgetWaitMs: { default: 250, range: [0, 5000] },
  /** Frames behind the playhead preview may show while the target is pending,
   * and the history the lookahead keeps. Not swept
   * (docs/notes/motif-preview-progress-2026-10-05.md, a local dev box). */
  recentFrames: { default: 3, range: [0, 30] },
  /** Cancellable lookahead subscriptions; also bounds the synchronous
   * admission work per replan (256 is about 4 s at 60 fps). Not measured. */
  prewarmRequests: { default: 256, range: [16, 4096] },
  /** Lookahead also warms layers that become visible within this time (ms).
   * Not measured. */
  prewarmLookaheadMs: { default: 500, range: [0, 5000] },
  /** Band threads per frame: one per this many hardware threads, at most
   * `maxBandThreads`. Measured: the sweep on the 16-thread bench, where more
   * threads per frame made the preview tick late during 4K playback
   * (docs/notes/motif-texture-upload-2026-11-07.md). */
  bandThreadDivisor: { default: 8, range: [1, 64] },
  maxBandThreads: { default: 2, range: [1, 8] },
  /** Decoded band buffers a process keeps between reads (bytes), sized for
   * three lanes of two band threads at 4K. Not swept
   * (docs/notes/motif-texture-upload-2026-11-07.md). */
  scratchIdleBytes: { default: 32 * MIB, range: [0, 256 * MIB] },
} as const satisfies Record<string, TuningKey>

export type MotifTuningKey = keyof typeof MOTIF_TUNING_SPEC
export type MotifTuning = { readonly [K in MotifTuningKey]: number }

const KEYS = Object.keys(MOTIF_TUNING_SPEC) as MotifTuningKey[]

export const MOTIF_TUNING_DEFAULTS: MotifTuning = Object.freeze(
  Object.fromEntries(KEYS.map(key => [key, MOTIF_TUNING_SPEC[key].default])) as Record<MotifTuningKey, number>,
)

/** The tuning a process runs with: the keys, and the band thread count main
 * resolved from its hardware threads. */
export interface ResolvedMotifTuning extends MotifTuning {
  readonly bandThreads: number
}

const isTuningKey = (key: string): key is MotifTuningKey => Object.hasOwn(MOTIF_TUNING_SPEC, key)

/** Parses `key=value,key=value` (the `WEFTCUT_MOTIF_TUNING` form). An entry
 * that names no key, or a value that is not an integer in its key's range,
 * leaves that key at its default and is reported in `problems`. */
export function parseMotifTuning(text: string | undefined): { tuning: MotifTuning; problems: string[] } {
  const tuning: Record<MotifTuningKey, number> = { ...MOTIF_TUNING_DEFAULTS }
  const problems: string[] = []
  for (const entry of (text ?? '').split(',')) {
    const item = entry.trim()
    if (!item) continue
    const at = item.indexOf('=')
    const key = (at < 0 ? item : item.slice(0, at)).trim()
    const raw = at < 0 ? '' : item.slice(at + 1).trim()
    if (!isTuningKey(key)) { problems.push(`unknown key '${key}'`); continue }
    const [min, max] = MOTIF_TUNING_SPEC[key].range
    const value = /^-?\d+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      problems.push(`${key}=${raw} is not an integer in [${min}, ${max}]`)
      continue
    }
    tuning[key] = value
  }
  return { tuning, problems }
}

/** Band threads per frame on a machine with `parallelism` hardware threads. */
export function motifBandThreads(tuning: MotifTuning, parallelism: number): number {
  return Math.min(tuning.maxBandThreads, Math.max(1, Math.floor(parallelism / tuning.bandThreadDivisor)))
}

/** Main passes the resolved tuning to renderer windows and the reader utility
 * on their argv; neither reads the environment. */
const TUNING_SWITCH = '--weftcut-motif-tuning='

export function motifTuningArgument(tuning: ResolvedMotifTuning): string {
  return TUNING_SWITCH + [...KEYS, 'bandThreads' as const].map(key => `${key}=${tuning[key]}`).join(',')
}

/** The tuning main passed, frozen; null when the argument is absent or does
 * not parse cleanly. */
export function readMotifTuningArgument(argv: readonly string[]): ResolvedMotifTuning | null {
  const text = argv.find(arg => arg.startsWith(TUNING_SWITCH))?.slice(TUNING_SWITCH.length)
  if (text === undefined) return null
  const entries = text.split(',')
  const threads = entries.find(entry => entry.startsWith('bandThreads='))?.slice('bandThreads='.length) ?? ''
  const { tuning, problems } = parseMotifTuning(entries.filter(entry => !entry.startsWith('bandThreads=')).join(','))
  const bandThreads = /^\d+$/.test(threads) ? Number(threads) : NaN
  if (problems.length || !(bandThreads >= 1 && bandThreads <= tuning.maxBandThreads)) return null
  return Object.freeze({ ...tuning, bandThreads })
}

/** Protocol deadlines and retry schedules of the Motif frame path. They bound
 * how long a failure takes to surface, not how fast frames flow, so they are
 * not overridable. The native keyed-mutex and device-idle waits are
 * `ACQUIRE_SYNC_TIMEOUT_MS` and `DEVICE_IDLE_TIMEOUT_MS` in `native/src/d3d.rs`. */
const deadlines = {
  /** Every CDP command to the capture host, and a rendered frame's paint. */
  captureCommandMs: 5000,
  /** Loading the capture host shell and the Motif in its frame. */
  captureLoadMs: 10_000,
  /** A Motif's awaited setup (model loading, decoder initialization). */
  captureSetupMs: 30_000,
  /** Readiness probes of a loading Motif page, and the wait between them. */
  readyAttempts: 30,
  readyPollMs: 100,
  /** The capture page's wait for a frame's rendering step; pacing only, the
   * marker proves what a paint shows. */
  renderStepMs: 100,
  /** The renderer's frame port for a capture: longer than setup, so it never
   * pre-empts it. */
  captureTransportMs: 60_000,
  /** The renderer's frame port for a read, and a utility-lane read. */
  readTransportMs: 15_000,
  /** The preload's proof that Chromium's copy out of a texture slot has run. */
  readBarrierMs: 2000,
  /** A texture-lane slot the page has not acknowledged is retired after this. */
  gpuLeaseMs: 5000,
  /** Reader utility restarts back off from min to max; a utility alive for
   * `readerStableMs` resets the backoff. */
  readerRestartMinMs: 250,
  readerRestartMaxMs: 8000,
  readerStableMs: 60_000,
  /** A preview frame that failed retries after these delays, and a lookahead
   * frame refused `capacity` is not requested again before them; the last
   * repeats. */
  previewRetryMs: Object.freeze([250, 1000, 4000]),
  /** A bake clip's failures before it is an error; the retry waits
   * `bakeRetryBaseMs · 2^(failures − 1)`. A `capacity` or `disk` pause
   * retries after `bakePauseRetryMs` and counts no failure. */
  bakeFailures: 3,
  bakeRetryBaseMs: 250,
  bakePauseRetryMs: 1000,
  /** Replacing a stored frame another process holds open (Windows): retries,
   * waiting `storeReplaceBackoffMs · attempt`. */
  storeReplaceRetries: 4,
  storeReplaceBackoffMs: 10,
}
export const MOTIF_DEADLINES: Readonly<typeof deadlines> = Object.freeze(deadlines)
