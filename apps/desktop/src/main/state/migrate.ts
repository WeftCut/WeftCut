// apps/desktop/src/main/state/migrate.ts
//
// The version-keyed upgrade chain for `project.json`. One step per schema
// generation, applied in sequence: v_n → v_n+1 → … → the build's version.
// `persistence.ts` owns the refusals (missing/non-numeric version, a file NEWER
// than the build) and calls in here for everything older.
//
// THE ONE RULE this file exists to enforce: a shape CONVERSION is a step here,
// with a version number attached. It is NOT an unconditional rewrite in
// `parseProject`. The version-blind normalize pass over there is for DEFAULTS
// (an additive optional field materializing) and VALIDITY REPAIRS (off-grid
// geometry, a flag that contradicts the data it describes) — both of which are
// idempotent statements about the *current* shape and carry no version. A
// conversion states "the shape used to be X and is now Y", which is exactly what
// a version number is for. Before this file existed the codebase had no way to
// say that, so three conversions rode the blind pass and the version never moved
// (see ADR 0047).
//
// WHY THIS FILE IMPORTS NOTHING FROM ./model — and must keep importing nothing:
// a step is a frozen statement about a shape that has already passed into
// history. If a step read `SCHEMA_VERSION`, a type, or `defaultSettings()` from
// the live model, it would silently re-anchor to whatever the model looks like
// years later — the step's meaning would change without the step being edited,
// and the failure would only ever surface on a real user's old file. So every
// step works on the WIRE object (`Record<string, unknown>`), declares local
// types for just the fields it touches, and writes frozen literals. There is no
// linter in this repo; `migrate.contract.test.ts` asserts the import ban by
// reading this file's source.
//
// The runner — never a step — owns `schema_version`: a step that had to stamp
// its own output version could forget, and a forgotten stamp is silent (the next
// step's `from` would not match and the walk would report a hole that isn't one).

/** The oldest on-disk schema version this build can upgrade FROM.
 *
 *  v1 is the initial format, not yet published. Nothing before it was released — the
 *  pre-release builds cut over rather than migrating (`docs/data-model.md`
 *  §Versioning) — so there is deliberately no step below this floor and a file
 *  claiming one is refused rather than guessed at. */
export const MIN_SCHEMA_VERSION = 1

/** External facts absent from old project.json. No live model or defaults enter
 * a migration: the host supplies the original Motif's manifest dimensions. */
export interface MigrationContext {
  motifSize?: (id: string, version: number) => readonly [number, number] | null
  mediaSize?: (id: string) => readonly [number, number] | null
  /** v3 numeric interpolation contract; injected canonical Wasm evaluator.
   * No current model defaults or serializers are allowed in the conversion. */
  sampleScalar?: (track: unknown, times: readonly number[], fallback: number) => number[]
  samplePosition?: (position: unknown, times: readonly number[]) => { x: number; y: number }[]
  onBake?: (report: PositionBakeReport) => void
}

export interface PositionBakeReport {
  compositionId: string
  layerId: string
  samples: number
  previousMode: 'XY' | 'Path'
}

export interface MigrationStep {
  /** The schema version this step READS. It produces `from + 1`. */
  from: number
  /** Convert the wire object in place. Receives the runner's private clone, so
   *  mutation is safe and expected; the caller's object is never touched. */
  apply(wire: Record<string, unknown>, context?: MigrationContext): void
}

/** The chain, in ascending `from` order.
 *
 *  v1 → v2 preserves existing clip silence when removing the inspector mute toggle.
 *  `migrate.completeness.test.ts` fails the build if a `SCHEMA_VERSION` bump
 *  arrives without one (and without its committed fixture). */
export const STEPS: readonly MigrationStep[] = [{
  from: 1,
  apply(wire) {
    // Visit every composition, including Groups. Only a clip's mute is folded
    // into enabled; track flags, role mixing and linked members remain independent.
    const compositions = wire.compositions as Record<string, { tracks?: unknown }> | undefined
    if (!compositions || typeof compositions !== 'object') return
    for (const composition of Object.values(compositions)) {
      if (!Array.isArray(composition?.tracks)) continue
      for (const track of composition.tracks) {
        if (!Array.isArray(track?.layers)) continue
        for (const layer of track.layers) {
          if (layer?.params?.kind !== 'Audio' || layer.params.mute !== true) continue
          layer.enabled = false
          layer.params.mute = false
        }
      }
    }
  },
}, {
  from: 2,
  apply(wire) {
    const compositions = wire.compositions as Record<string, { tracks?: unknown }> | undefined
    if (!compositions || typeof compositions !== 'object') return
    for (const composition of Object.values(compositions)) {
      if (!Array.isArray(composition?.tracks)) continue
      for (const track of composition.tracks) {
        if (!Array.isArray(track?.layers)) continue
        for (const layer of track.layers) {
          const params = layer?.params
          if (!params || !['VideoClip', 'Audio', 'ImageOverlay', 'Motif', 'CompositionRef'].includes(params.kind)) continue
          // Old VideoClip.speed was inert. Do NOT recurse into Motif props or
          // preserve the old number as a second, accidentally live rate.
          if (params.kind === 'VideoClip') delete params.speed
          params.time_map = { kind: 'Affine', rate: { num: 1, den: 1 } }
          params.frame_interpolation = { kind: 'FrameSampling' }
          if (params.kind === 'Audio' || params.kind === 'CompositionRef') params.preserve_pitch = true
          if (params.kind === 'ImageOverlay' || params.kind === 'Motif') {
            const start = params.kind === 'Motif' ? (params.src_in_us ?? 0) : 0
            params.content_window = { in_us: start, out_us: start + layer.t_end_us - layer.t_start_us }
          }
        }
      }
    }
  },
}, {
  from: 3,
  apply(wire, context = {}) {
    // Frozen v3/v4 wire shapes. Text already stored its anchor position.
    type Scalar = { mode: 'Static'; value: number } | {
      mode: 'Keyframed'; value: { value: number; [key: string]: unknown }[]; extrapolate?: { before: string; after: string }
    }
    type Transform = {
      position: { mode: 'XY'; x: Scalar; y: Scalar } | {
        mode: 'Path'; path: { nodes: { point: { x: number; y: number } }[] }
      }
      anchor_x?: Scalar; anchor_y?: Scalar; scale_x: Scalar; scale_y: Scalar
    }
    type Fraction = { num: number; den: number }
    type Composition = { width: number; height: number; fps: Fraction; duration_us: number;
      transitions?: { duration_us: number }[]; tracks: { layers: {
      id: string; t_start_us: number; t_end_us: number; params: { kind: string; media?: string; composition?: string;
        motif_id?: string; motif_version?: number; transform?: Transform;
        src_in_us?: number; time_map?: { kind: string; rate: Fraction };
        source_phase?: { in: Fraction } }
    }[] }[] }
    const compositions = wire.compositions as Record<string, Composition>
    const pool = wire.media_pool as Record<string, { metadata?: { video?: { width: number; height: number } } }>
    const constant = (track: Scalar | undefined, fallback: number): number | null => {
      if (!track) return fallback
      if (track.mode === 'Static') return track.value
      if (track.value.length === 0) return fallback
      const value = track.value[0].value
      return track.value.every(key => key.value === value) ? value : null
    }
    const shift = (track: Scalar, offset: number): Scalar => {
      if (track.mode === 'Static') track.value += offset
      else if (!track.value.length) return { mode: 'Static', value: offset }
      else for (const key of track.value) key.value += offset
      return track
    }
    // Rational sample clocks preserve sub-microsecond Group phases/rates. The
    // direct composition grid uses the shipped v3 half-up microsecond policy.
    const rational = (n: bigint, d = 1n): Fraction => {
      if (d <= 0n) throw new Error('Schema v3 → v4: invalid sample denominator')
      let a = n < 0n ? -n : n, b = d
      while (b) { const r = a % b; a = b; b = r }
      n /= a; d /= a
      const num = Number(n), den = Number(d)
      if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) throw new Error('Schema v3 → v4: sample time overflow')
      return { num, den }
    }
    const add = (a: Fraction, b: Fraction) => rational(BigInt(a.num) * BigInt(b.den) + BigInt(b.num) * BigInt(a.den), BigInt(a.den) * BigInt(b.den))
    const mul = (a: Fraction, b: Fraction) => rational(BigInt(a.num) * BigInt(b.num), BigInt(a.den) * BigInt(b.den))
    const value = (t: Fraction) => t.num / t.den
    let sampleClocks: Map<string, Map<string, Fraction>> | undefined
    const clocks = () => {
      if (sampleClocks) return sampleClocks
      const result = new Map<string, Map<string, Fraction>>()
      let visits = 0
      const visit = (id: string, at: Fraction, ancestors: Set<string>) => {
        if (ancestors.has(id)) throw new Error('Schema v3 → v4: cyclic Group reference')
        const c = compositions[id]
        if (!c) throw new Error(`Schema v3 → v4: missing composition ${id}`)
        const key = `${at.num}/${at.den}`
        let times = result.get(id)
        if (!times) { times = new Map(); result.set(id, times) }
        if (times.has(key)) return
        if (++visits > 2_000_000) throw new Error('Schema v3 → v4: migration sample budget exceeded; original project unchanged')
        times.set(key, at)
        const stack = new Set(ancestors).add(id)
        const margin = Math.max(0, ...(c.transitions ?? []).map(t => t.duration_us))
        for (const track of c.tracks ?? []) for (const layer of track.layers ?? []) {
          const p = layer.params
          if (p.kind !== 'CompositionRef' || value(at) < layer.t_start_us - margin || value(at) > layer.t_end_us + margin) continue
          if (p.time_map && p.time_map.kind !== 'Affine') throw new Error('Schema v3 → v4: unsupported Group time map')
          const local = add(at, { num: -layer.t_start_us, den: 1 })
          const start = add({ num: p.src_in_us ?? 0, den: 1 }, p.source_phase?.in ?? { num: 0, den: 1 })
          visit(p.composition!, add(start, mul(local, p.time_map?.rate ?? { num: 1, den: 1 })), stack)
        }
      }
      for (const [id, c] of Object.entries(compositions)) {
        if (!c.fps || !(c.fps.num > 0 && c.fps.den > 0) || !Number.isFinite(c.duration_us)) throw new Error('Schema v3 → v4: invalid composition clock')
        const count = Math.ceil(c.duration_us * c.fps.num / (1_000_000 * c.fps.den))
        if (count > 2_000_000) throw new Error('Schema v3 → v4: migration sample budget exceeded; original project unchanged')
        for (let frame = 0; frame <= count; frame++) {
          visit(id, { num: Math.round(frame * 1_000_000 * c.fps.den / c.fps.num), den: 1 }, new Set())
        }
      }
      sampleClocks = result
      return result
    }
    let keySequence = 0
    const usedIds = new Set<string>()
    // Key IDs remain unique even when an older project contains migration IDs.
    JSON.stringify(wire, (key, v) => { if (key === 'id' && typeof v === 'string') usedIds.add(v); return v })
    const keyId = () => {
      let id: string
      do { id = `00000000-0000-4000-8000-${(++keySequence).toString(16).padStart(12, '0')}` } while (usedIds.has(id))
      usedIds.add(id); return id
    }
    for (const [compositionId, composition] of Object.entries(compositions ?? {})) {
      for (const track of composition.tracks ?? []) for (const layer of track.layers ?? []) {
        const p = layer.params
        if (!['VideoClip', 'ImageOverlay', 'Motif', 'CompositionRef'].includes(p.kind)) continue
        const t = p.transform
        if (!t) throw new Error(`Schema v3 → v4: clip ${layer.id} has no transform`)
        const ax = constant(t.anchor_x, 0.5), ay = constant(t.anchor_y, 0.5)
        const sx = constant(t.scale_x, 1), sy = constant(t.scale_y, 1)
        const factor = (anchor: number | null, scale: number | null) =>
          anchor === 0 || scale === 0 ? 0 : anchor !== null && scale !== null ? anchor * Math.abs(scale) : null
        const fx = factor(ax, sx), fy = factor(ay, sy)
        let size: readonly [number, number] | null | undefined
        if (p.kind === 'Motif') size = context.motifSize?.(p.motif_id!, p.motif_version!)
        else {
          const source = p.kind === 'CompositionRef' ? compositions[p.composition!] : pool?.[p.media!]?.metadata?.video
          if (source) size = [source.width, source.height]
          else if (p.media) size = context.mediaSize?.(p.media)
        }
        if ((fx !== 0 || fy !== 0) && (!size || !size.every(v => Number.isFinite(v) && v > 0))) {
          throw new Error(`Schema v3 → v4: source dimensions unavailable for ${p.kind} clip ${layer.id}` +
            (p.kind === 'Motif' ? ` (${p.motif_id} v${p.motif_version}); restore its matching Motif manifest` : '; restore its media metadata') +
            '. The original project was not changed.')
        }
        if (fx === null || fy === null) {
          if (!context.sampleScalar || !context.samplePosition) throw new Error('Schema v3 → v4: animation evaluator unavailable')
          const margin = Math.max(0, ...(composition.transitions ?? []).map(t => t.duration_us))
          const span = layer.t_end_us - layer.t_start_us
          const times = new Map<string, Fraction>()
          for (const at of clocks().get(compositionId)?.values() ?? []) {
            const local = add(at, { num: -layer.t_start_us, den: 1 })
            if (value(local) >= -margin && value(local) <= span + margin) times.set(`${local.num}/${local.den}`, local)
          }
          for (const num of [0, span]) times.set(`${num}/1`, { num, den: 1 })
          const exact = [...times.values()].sort((a, b) => value(a) - value(b))
          // Fail atomically rather than creating a track the v4 evaluator would
          // silently truncate. The cap is a frozen v4 wire/runtime constraint.
          if (exact.length > 4096) throw new Error(`Schema v3 → v4: clip ${layer.id} requires ${exact.length} position samples (limit 4096); original project unchanged`)
          const numeric = exact.map(value)
          const points = context.samplePosition(t.position, numeric)
          const axes = ['x', 'y'] as const
          const tracks = axes.map((axis, index) => {
            const anchors = context.sampleScalar!(t[axis === 'x' ? 'anchor_x' : 'anchor_y'], numeric, 0.5)
            const scales = context.sampleScalar!(t[axis === 'x' ? 'scale_x' : 'scale_y'], numeric, 1)
            return { mode: 'Keyframed' as const, value: exact.map((at, i) => {
              const t_us = Math.floor(value(at))
              const remainder = add(at, { num: -t_us, den: 1 })
              const coordinate = points[i][axis] + anchors[i] * Math.abs(scales[i]) * size![index]
              if (!Number.isFinite(coordinate)) throw new Error(`Schema v3 → v4: invalid sampled position for ${layer.id}`)
              return { id: keyId(), t_us, ...(remainder.num ? { time_fraction: remainder } : {}), value: coordinate,
                in: { x: 2 / 3, y: 2 / 3, mode: 'Free' }, out: { x: 1 / 3, y: 1 / 3, mode: 'Free' },
                continuity: 'Broken', segment: { kind: 'Linear' } }
            }), extrapolate: { before: 'Hold', after: 'Hold' } }
          })
          const previousMode = t.position.mode
          t.position = { mode: 'XY', x: tracks[0], y: tracks[1] }
          context.onBake?.({ compositionId, layerId: layer.id, samples: exact.length, previousMode })
          continue
        }
        const dx = fx === 0 ? 0 : fx * size![0], dy = fy === 0 ? 0 : fy * size![1]
        if (t.position.mode === 'XY') { t.position.x = shift(t.position.x, dx); t.position.y = shift(t.position.y, dy) }
        else for (const node of t.position.path.nodes) { node.point.x += dx; node.point.y += dy }
      }
    }
  },
}, {
  from: 4,
  apply(wire) {
    // v5 tags visual layers with a graphic role. Every existing Text, Motif and
    // ImageOverlay layer, in every composition, is untagged: a Motif's manifest
    // role applies at placement only and is NOT back-filled here.
    const compositions = wire.compositions as Record<string, { tracks?: unknown }> | undefined
    if (!compositions || typeof compositions !== 'object') return
    for (const composition of Object.values(compositions)) {
      if (!Array.isArray(composition?.tracks)) continue
      for (const track of composition.tracks) {
        if (!Array.isArray(track?.layers)) continue
        for (const layer of track.layers) {
          const params = layer?.params
          if (!params || !['Text', 'Motif', 'ImageOverlay'].includes(params.kind)) continue
          params.graphic_role = null
        }
      }
    }
  },
}]

export interface UpgradeOutcome {
  /** The wire object at the target version. Identical reference to the input
   *  when nothing ran; a clone when it did. */
  wire: Record<string, unknown>
  /** The version the input was at. */
  from: number
}

/** Walk `wire` from its own version up to `to`.
 *
 *  `steps` is injectable so synthetic chains can exercise multi-step walks,
 *  stamping, clone isolation and missing-step errors independently of the
 *  currently registered conversions. Production always passes the default.
 *
 *  Clones once up front rather than mutating in place: a step that throws
 *  half-way leaves the caller's object untouched, so the error path can report
 *  the ORIGINAL file rather than a half-upgraded hybrid. */
export function upgradeWire(
  wire: Record<string, unknown>,
  from: number,
  to: number,
  steps: readonly MigrationStep[] = STEPS,
  context: MigrationContext = {},
): UpgradeOutcome {
  if (from === to) return { wire, from }
  if (from > to) {
    // Defensive: persistence.ts refuses newer-than-build before we are called.
    throw new Error(`project schema v${from} is ahead of v${to}; there is no downgrade path`)
  }
  if (from < MIN_SCHEMA_VERSION) {
    throw new Error(
      `project schema v${from} predates the oldest upgradable version (v${MIN_SCHEMA_VERSION}) — ` +
      `re-create the project in a fresh workspace.`,
    )
  }

  const out = structuredClone(wire)
  for (let v = from; v < to; v += 1) {
    const step = steps.find((s) => s.from === v)
    if (step === undefined) {
      // Unreachable while the completeness test is green — it asserts the chain
      // covers every version from MIN to current. Kept because "unreachable"
      // depends on a test staying green, and a wrong upgrade is worse than a
      // refused open.
      throw new Error(
        `no upgrade step from project schema v${v} to v${v + 1}: the migration chain is incomplete ` +
        `(this build reads v${to}).`,
      )
    }
    step.apply(out, context)
    out.schema_version = v + 1
  }
  return { wire: out, from }
}
