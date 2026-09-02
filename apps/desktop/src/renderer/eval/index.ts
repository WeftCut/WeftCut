// Single source of truth for the WYSIWYG math: thin typed wrappers over the
// weftcut-eval wasm module (compiled from native/eval — the SAME crate the native
// audio and state code link natively; the main-process TS actor re-exports these
// same wrappers through `main/state/snap.ts`). Tracks are uploaded once per
// (handle, version) into a resident buffer and evaluated per-frame with
// scalar-only calls. `initEval()` must be awaited before any wrapper is called
// (the renderer bootstrap does so).
import { EVAL_WASM_BASE64 } from './evalWasm.generated'
import {
  HOLD_EXTRAPOLATION,
  type Extrapolate,
  type Extrapolation,
  type Segment,
} from '../../shared/keyframe'

interface Exports {
  snap_round(tUs: number, num: number, den: number): number
  snap_floor(tUs: number, num: number, den: number): number
  snap_ceil(tUs: number, num: number, den: number): number
  time_us_at_frame(frame: number, num: number, den: number): number
  frame_index_floor(tUs: number, num: number, den: number): number
  frame_index_round(tUs: number, num: number, den: number): number
  frame_index_ceil(tUs: number, num: number, den: number): number
  frame_count(startUs: number, endUs: number, num: number, den: number): number
  us_to_frame(us: number, rate: number): number
  set_n(n: number, before: number, after: number): void
  set_kf(
    i: number,
    tUs: number,
    value: number,
    outX: number,
    outY: number,
    inX: number,
    inY: number,
    seg: number,
    s0: number,
    s1: number,
    s2: number,
  ): void
  eval(tUs: number, def: number): number
  set_n_rgba(n: number, before: number, after: number): void
  set_kf_rgba(
    i: number,
    tUs: number,
    packed: number,
    outX: number,
    outY: number,
    inX: number,
    inY: number,
    seg: number,
    s0: number,
    s1: number,
    s2: number,
  ): void
  eval_rgba_packed(tUs: number, defPacked: number): number
  db_to_linear(db: number): number
  role_audible(muted: number, solo: number, anySolo: number): number
  pan_coeff(pan: number, channels: number, idx: number): number
  fade_mul(tUs: number, spanUs: number, fadeInUs: number, fadeOutUs: number): number
}

let ex: Exports | null = null

/// `(segment code, s0, s1, s2)` — the wasm `set_kf`/`set_kf_rgba` slots for one
/// keyframe's segment class. The Spline tangents ride in their own four slots
/// (`out.x, out.y, in.x, in.y`), not here.
///
/// Code table — KEEP in lockstep with `native/eval/src/wasm.rs::decode_segment`:
///   0 = Hold, 1 = Linear, 4 = Spline, 5 = Elastic, 6 = Bounce.
/// Codes 2/3 are RETIRED (the removed named EaseIn/EaseOut variants) and must
/// never be reassigned — a stale caller sending them must not get a different
/// curve than it asked for. Param-slot layout mirrors `decode_segment`:
///   Elastic: s0 = dir, s1 = amplitude, s2 = period
///   Bounce:  s0 = dir
/// Dir codes (`decode_dir`): 0 = In, 1 = Out, 2 = InOut.
///
/// An unrecognized kind (only reachable through a cast hole — the wire type is
/// closed) falls back to Linear: visible motion rather than a silently wrong
/// curve, the same deliberate policy as the Rust side's debug assert.
function encodeSegment(seg: Segment): [number, number, number, number] {
  switch (seg.kind) {
    case 'Hold':
      return [0, 0, 0, 0]
    case 'Linear':
      return [1, 0, 0, 0]
    case 'Spline':
      return [4, 0, 0, 0]
    case 'Elastic':
      return [5, dirCode(seg.dir), seg.amplitude, seg.period]
    case 'Bounce':
      return [6, dirCode(seg.dir), 0, 0]
    default:
      console.assert(false, `weftcut-eval: unknown segment kind, evaluating as Linear`, seg)
      return [1, 0, 0, 0]
  }
}

/// `Extrapolate` → ABI code. KEEP in lockstep with
/// `native/eval/src/wasm.rs::decode_extrapolate`:
///   0 = Hold, 1 = Loop, 2 = PingPong, 3 = Offset, 4 = Continue.
/// Unknown (cast hole) → Hold, the clamp — no motion invented.
function encodeExtrapolate(mode: Extrapolate): number {
  switch (mode) {
    case 'Hold':
      return 0
    case 'Loop':
      return 1
    case 'PingPong':
      return 2
    case 'Offset':
      return 3
    case 'Continue':
      return 4
    default:
      console.assert(false, `weftcut-eval: unknown extrapolate mode '${String(mode)}', evaluating as Hold`)
      return 0
  }
}

/// `EaseDir` → ABI dir code. Unknown (cast hole) → In, mirroring `decode_dir`.
function dirCode(dir: string): number {
  if (dir === 'In') return 0
  if (dir === 'Out') return 1
  if (dir === 'InOut') return 2
  console.assert(false, `weftcut-eval: unknown ease dir '${dir}', evaluating as In`)
  return 0
}

function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  // Back the view with an explicit `ArrayBuffer` so the type resolves to
  // `Uint8Array<ArrayBuffer>` (a valid `BufferSource`); a bare `new
  // Uint8Array(len)` widens to `<ArrayBufferLike>` under @types/node, which
  // `WebAssembly.compile` rejects. The renderer (Chromium) + Node (vitest) both
  // have `atob`; `Buffer` is the Node fallback if a future test env lacks it.
  const bin =
    typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('latin1')
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export async function initEval(): Promise<void> {
  if (ex) return
  const bytes = decodeBase64(EVAL_WASM_BASE64)
  // compile-then-instantiate (not the bytes overload of instantiate) keeps the
  // result type unambiguous: instantiate(Module) returns a bare Instance.
  const module = await WebAssembly.compile(bytes)
  const instance = await WebAssembly.instantiate(module, {})
  ex = instance.exports as unknown as Exports
}

function E(): Exports {
  if (!ex) throw new Error('initEval() not awaited before eval use')
  return ex
}

// ---------------------------------------------------------------------------
// Frame grid. One wrapper per leaf primitive; `renderer/frames.ts` is the
// surface the app imports (it adds the composition-level helpers). Degenerate
// fps (a transient 0 from seek/UI — the actor never stores one) short-circuits
// HERE rather than in the leaf, which contracts for a valid rate: a snap returns
// its input untouched, an index/count answers 0.
// ---------------------------------------------------------------------------

/** Round `tUs` to the nearest frame boundary (half-up). */
export function snapFrameRound(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return tUs
  return E().snap_round(tUs, num, den)
}

/** Floor `tUs` to the canonical start of the frame containing it. */
export function snapFrameFloor(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return tUs
  return E().snap_floor(tUs, num, den)
}

/** Ceil `tUs` to the next canonical frame start (identity when already on one). */
export function snapFrameCeil(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return tUs
  return E().snap_ceil(tUs, num, den)
}

/** Canonical µs of frame index `frame` — the ONLY frame-index-to-time policy
 * (half-up). Every grid time in the project traces back to this. */
export function timeUsAtFrame(frame: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return 0
  return E().time_us_at_frame(frame, num, den)
}

/** Index of the frame containing `tUs`. */
export function frameIndexFloor(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return 0
  return E().frame_index_floor(tUs, num, den)
}

/** Index of the frame boundary nearest `tUs` (half-up). */
export function frameIndexRound(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return 0
  return E().frame_index_round(tUs, num, den)
}

/** Index of the first frame at or after `tUs`. */
export function frameIndexCeil(tUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return 0
  return E().frame_index_ceil(tUs, num, den)
}

/** Grid frames in the half-open range `[startUs, endUs)`. */
export function frameCount(startUs: number, endUs: number, num: number, den: number): number {
  if (num <= 0 || den <= 0) return 0
  return E().frame_count(startUs, endUs, num, den)
}

/** µs → sample-frame index at `rate` Hz (half-up). Shared with the export mixer
 * (`audio/mix.rs::us_to_frame`) through the leaf so preview + export place audio
 * on one grid. */
export function usToFrame(us: number, rate: number): number {
  return E().us_to_frame(us, rate)
}

/** A unit-square control point — what the buffer needs of a `Tangent`. */
interface Side {
  x: number
  y: number
}

/** Keyframe shape the resident buffer needs: a structural subset of the shared
 * `Keyframe<number>` (render/animated.ts hands tracks straight through), minus
 * the authoring-only tangent modes and continuity the engine never reads. */
export interface Kf {
  t_us: number
  value: number
  in: Side
  out: Side
  segment: Segment
}

/** Resident keyframe-buffer capacity — mirrors `MAXKF` in
 * native/eval/src/wasm.rs. Bounds ONE animated property of ONE layer (an
 * `AnimTrack` / Rust `Animated<T>` — e.g. a single clip's opacity or x), NOT a
 * timeline track or a whole clip (each property is uploaded separately). A
 * static-allocation backstop (the no_std wasm build has no heap), not a product
 * limit: manual authoring never approaches it. Known limit: beyond this the wasm
 * preview truncates while native export evaluates every keyframe, so they can
 * diverge — see docs/render.md. */
export const MAX_KEYFRAMES = 256

let loadedHandle = -1
let loadedN = 0
let loadedBefore = -1
let loadedAfter = -1
let warnedOverflow = false
/** Upload a property's keyframes into the resident wasm buffer ONCE, cached by a
 * monotonically-assigned handle (see render/animated.ts). Re-uploads only when
 * the handle differs from the last-loaded — so per-frame eval pays no marshaling.
 * The extrapolation codes ride on `set_n`, so a same-handle call whose codes
 * differ re-issues only that one call. */
export function loadTrack(
  handle: number,
  kfs: readonly Kf[],
  extrapolate: Extrapolation = HOLD_EXTRAPOLATION,
): void {
  const e = E()
  const before = encodeExtrapolate(extrapolate.before)
  const after = encodeExtrapolate(extrapolate.after)
  if (handle === loadedHandle) {
    if (before !== loadedBefore || after !== loadedAfter) {
      e.set_n(loadedN, before, after)
      loadedBefore = before
      loadedAfter = after
    }
    return
  }
  if (kfs.length > MAX_KEYFRAMES && !warnedOverflow) {
    warnedOverflow = true
    console.warn(
      `weftcut-eval: an animated property has ${kfs.length} keyframes; only the ` +
        `first ${MAX_KEYFRAMES} are evaluated in the wasm preview. Native export ` +
        `uses all of them, so preview may diverge from export. Known limit — see ` +
        `docs/render.md.`,
    )
  }
  const n = Math.min(kfs.length, MAX_KEYFRAMES)
  for (let i = 0; i < n; i++) {
    const k = kfs[i]!
    const [c, s0, s1, s2] = encodeSegment(k.segment)
    e.set_kf(i, k.t_us, k.value, k.out.x, k.out.y, k.in.x, k.in.y, c, s0, s1, s2)
  }
  e.set_n(n, before, after)
  loadedHandle = handle
  loadedN = n
  loadedBefore = before
  loadedAfter = after
}

export function evalTrack(tUs: number, def: number): number {
  return E().eval(tUs, def)
}

// ---------------------------------------------------------------------------
// Color keyframes. An `Rgba8` crosses the scalars-only ABI as ONE packed i32
// (RGBA8). The resident color buffer is INDEPENDENT of the scalar one — its own
// cache var below — but reuses MAX_KEYFRAMES + the same overflow-warn pattern.
// ---------------------------------------------------------------------------

/** Color value structurally compatible with the IPC `Rgba` (kept local so this
 * layer stays dependency-light). */
export interface RgbaLike {
  r: number
  g: number
  b: number
  a: number
}

/** Color keyframe shape (mirrors `Kf` for color values). */
export interface KfColor {
  t_us: number
  value: RgbaLike
  in: Side
  out: Side
  segment: Segment
}

// Pack/unpack MUST be byte-identical to the Rust shim (`wasm.rs`): r in the HIGH
// byte. `>>> 0` / `& 0xff` keep the values unsigned (JS `<<`/`>>` are signed).
const packRgba = (c: RgbaLike) => (c.r << 24) | (c.g << 16) | (c.b << 8) | c.a
const unpackRgba = (p: number): RgbaLike => {
  const u = p >>> 0
  return { r: (u >>> 24) & 0xff, g: (u >>> 16) & 0xff, b: (u >>> 8) & 0xff, a: u & 0xff }
}

let loadedColorHandle = -1
let loadedColorN = 0
let loadedColorBefore = -1
let loadedColorAfter = -1
let warnedColorOverflow = false
/** Upload a color property's keyframes into the resident wasm COLOR buffer ONCE,
 * cached by handle (twin of `loadTrack`; separate buffer + cache vars, same
 * re-issue-`set_n_rgba` rule for a changed extrapolation). */
export function loadColorTrack(
  handle: number,
  kfs: readonly KfColor[],
  extrapolate: Extrapolation = HOLD_EXTRAPOLATION,
): void {
  const e = E()
  const before = encodeExtrapolate(extrapolate.before)
  const after = encodeExtrapolate(extrapolate.after)
  if (handle === loadedColorHandle) {
    if (before !== loadedColorBefore || after !== loadedColorAfter) {
      e.set_n_rgba(loadedColorN, before, after)
      loadedColorBefore = before
      loadedColorAfter = after
    }
    return
  }
  if (kfs.length > MAX_KEYFRAMES && !warnedColorOverflow) {
    warnedColorOverflow = true
    console.warn(
      `weftcut-eval: an animated color property has ${kfs.length} keyframes; only ` +
        `the first ${MAX_KEYFRAMES} are evaluated in the wasm preview. Native export ` +
        `uses all of them, so preview may diverge from export. Known limit — see ` +
        `docs/render.md.`,
    )
  }
  const n = Math.min(kfs.length, MAX_KEYFRAMES)
  for (let i = 0; i < n; i++) {
    const k = kfs[i]!
    const [c, s0, s1, s2] = encodeSegment(k.segment)
    e.set_kf_rgba(i, k.t_us, packRgba(k.value), k.out.x, k.out.y, k.in.x, k.in.y, c, s0, s1, s2)
  }
  e.set_n_rgba(n, before, after)
  loadedColorHandle = handle
  loadedColorN = n
  loadedColorBefore = before
  loadedColorAfter = after
}

/** Evaluate the resident color track at `tUs` (OkLab + premult, via the leaf). */
export function evalRgbaPacked(tUs: number, def: RgbaLike): RgbaLike {
  return unpackRgba(E().eval_rgba_packed(tUs, packRgba(def)))
}

export function dbToLinear(db: number): number {
  return E().db_to_linear(db)
}

export function roleAudible(muted: boolean, solo: boolean, anySolo: boolean): boolean {
  return E().role_audible(muted ? 1 : 0, solo ? 1 : 0, anySolo ? 1 : 0) !== 0
}

/** Equal-power pan coefficient `[a,b,c,d][idx]` for `(pan, channels)` — the
 * leaf law shared with the export mixer. `channels` 1 (mono) or 2 (stereo). */
export function panCoeff(pan: number, channels: number, idx: number): number {
  return E().pan_coeff(pan, channels, idx)
}

/** Fade ramp multiplier — the leaf's `fade_multiplier`, which the native side
 * reaches through `audio/envelope.rs`. */
export function fadeMul(
  tUs: number,
  spanUs: number,
  fadeInUs: number,
  fadeOutUs: number,
): number {
  return E().fade_mul(tUs, spanUs, fadeInUs, fadeOutUs)
}
