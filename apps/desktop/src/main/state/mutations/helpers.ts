import { current, isDraft } from 'immer'
import type { Composition, Layer, LayerParams, Project, Track, Uuid } from '../model'
import { CommandFailure } from '../errors'
import { frameGrid, snapUpOnGrid } from '../snap'
import { forEachAnimatedF64, forEachAnimatedRgba, shiftKeyframes } from './animated'

/** Deep-clone a layer whether it came from an Immer recipe or plain test data. */
export function cloneLayer(layer: Layer): Layer {
  return structuredClone(isDraft(layer) ? current(layer) : layer)
}

/** A layer with its holders. `comp` is the scope every mutation on the layer
 *  edits — the composition's own tracks, links, transitions, duration. The
 *  indices are read at locate time: a splice on `track.layers` stales
 *  `layerIndex`, so re-locate after one rather than reuse it. */
export interface LocatedLayer { comp: Composition; track: Track; layer: Layer; trackIndex: number; layerIndex: number }
export interface LocatedTrack { comp: Composition; track: Track; trackIndex: number }

/** `p.compositions[id]` or CompositionNotFound. */
export function compositionOf(p: Project, id: Uuid): Composition {
  const c = p.compositions[id]
  if (!c) throw new CommandFailure({ error: 'CompositionNotFound', composition: id })
  return c
}

/** `p.compositions[id]`, or null. */
export function locateComposition(p: Project, id: Uuid): Composition | null {
  return p.compositions[id] ?? null
}

/** The composition a CREATION op places into: the one named, else the root.
 *  Creation ops are the only ops that take a scope argument — a layer-addressed
 *  op derives its scope from the layer (see `locateLayer`). */
export function scopeComposition(p: Project, compositionId?: Uuid | null): Composition {
  return compositionOf(p, compositionId ?? p.root_id)
}

export function locateLayerIn(c: Composition, id: Uuid): LocatedLayer | null {
  for (let ti = 0; ti < c.tracks.length; ti++) {
    const track = c.tracks[ti]
    const li = track.layers.findIndex((l) => l.id === id)
    if (li >= 0) return { comp: c, track, layer: track.layers[li], trackIndex: ti, layerIndex: li }
  }
  return null
}

/** Find a layer in WHICHEVER composition holds it. Layer ids are unique
 *  project-wide (validate: `DuplicateLayerId` spans compositions), which is what
 *  lets every layer-addressed op derive its composition here instead of taking
 *  a scope argument — an agent moving a layer inside a Group never has to know
 *  it is in one (ADR 0052; spec § Invariants). */
export function locateLayer(p: Project, id: Uuid): LocatedLayer | null {
  for (const c of Object.values(p.compositions)) {
    const found = locateLayerIn(c, id)
    if (found) return found
  }
  return null
}

/** `locateLayer` or LayerNotFound. */
export function requireLayer(p: Project, id: Uuid): LocatedLayer {
  const found = locateLayer(p, id)
  if (!found) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  return found
}

/** Find a track in whichever composition holds it (track ids are minted by
 *  the one id stream, so a track lives in exactly one). */
export function locateTrack(p: Project, id: Uuid): LocatedTrack | null {
  for (const c of Object.values(p.compositions)) {
    const ti = c.tracks.findIndex((t) => t.id === id)
    if (ti >= 0) return { comp: c, track: c.tracks[ti], trackIndex: ti }
  }
  return null
}

/** `locateTrack` or TrackNotFound. */
export function requireTrack(p: Project, id: Uuid): LocatedTrack {
  const found = locateTrack(p, id)
  if (!found) throw new CommandFailure({ error: 'TrackNotFound', track: id })
  return found
}

/** The ONE composition a set of layers lives in. LayerNotFound for an unknown
 *  member (checked in input order, before any scope comparison, so a missing
 *  id is reported as missing rather than as a scope mismatch), then
 *  CrossCompositionSet naming the first member outside the first member's
 *  composition. Empty input is the caller's to refuse. */
export function requireSameComposition(p: Project, layerIds: readonly Uuid[]): Composition {
  let comp: Composition | null = null
  for (const id of layerIds) {
    const found = requireLayer(p, id)
    if (comp === null) comp = found.comp
    else if (found.comp !== comp) throw new CommandFailure({ error: 'CrossCompositionSet', layer: id, composition: found.comp.id, expected: comp.id })
  }
  if (comp === null) throw new CommandFailure({ error: 'InvalidArgument', field: 'layers', detail: 'at least one layer is required' })
  return comp
}

/** Reconcile composition.duration_us with the layer high-water mark (ADR 0005).
 *
 *  The high-water mark is rounded UP to the enclosing composition frame, which
 *  matters only once audio lives on the 48 kHz lattice (spec R2-D6): an audio
 *  `t_end_us` is a sample boundary and at 29.97 / 59.94 that is generally NOT a
 *  frame boundary, so copying it verbatim would put `duration_us` off the frame grid
 *  and validate would reject the edit that caused it (`OffGridTime`). Up, not
 *  nearest: content ending mid-frame occupies that frame, and rounding down would
 *  make the composition shorter than its own content. Identity for frame-aligned
 *  content, which is every visual layer and all audio at the six rates where the
 *  frame lattice is an exact sublattice of the sample lattice. */
export function applyDurationAutofit(c: Composition): void {
  let maxEnd = 0
  for (const t of c.tracks) for (const l of t.layers) if (l.t_end_us > maxEnd) maxEnd = l.t_end_us
  const grid = frameGrid(c.fps)
  const fitted = maxEnd > 0 ? snapUpOnGrid(maxEnd, grid) : 0
  if (c.duration_pinned) { if (fitted > c.duration_us) c.duration_us = fitted }
  else c.duration_us = fitted
}

/** A track disappears when its last layer leaves it (ADR 0042). The one prune,
 *  called by every path that can empty a track, with the track the caller just
 *  emptied — never a project-wide sweep, so a track that was *born* empty was
 *  never emptied and survives, and no edit can make a track vanish elsewhere.
 *
 *  `transient` reads as "not part of the reserved skeleton": it is stamped on
 *  every role-less track at creation, so it is the cleanup-candidate flag rather
 *  than the narrower import-spawned marker its name suggests. `!locked` because
 *  locking is the user pinning a row, and cleanup does not out-rank that.
 *
 *  Returns the removed track id, so a caller can report what went with the edit. */
export function pruneEmptiedTrack(c: Composition, trackId: Uuid): Uuid | null {
  const idx = c.tracks.findIndex((t) => t.id === trackId)
  if (idx < 0) return null
  const t = c.tracks[idx]
  if (t.layers.length !== 0 || !t.transient || t.locked) return null
  c.tracks.splice(idx, 1)
  return trackId
}

/** Insert a layer keeping the track's layers ordered by `t_start_us` — the order
 *  validate's overlap scan walks in, since it compares each layer only against
 *  the previous one of its class. */
export function insertSorted(track: Track, layer: Layer): void {
  const at = track.layers.findIndex((l) => l.t_start_us > layer.t_start_us)
  track.layers.splice(at < 0 ? track.layers.length : at, 0, layer)
}

/** Scan tracks in reverse for the first non-reserved, UNLOCKED track with no
 *  layer overlap in [t0, t1). Returns null if none found, which means the
 *  caller must spawn a track via `applyAddTrack`. This IS ADR 0042's bounce
 *  policy ("no free lane, so make one"); it lives here rather than commands.ts
 *  so the transition mutations can share it without importing the command
 *  adapter (commands.ts imports mutations — the reverse edge would cycle).
 *  commands.ts re-exports it for its own consumers.
 *
 *  Locked lanes are never candidates: every caller PLACES content on the
 *  returned lane (agent color/text adds, paste, transition sibling bounces),
 *  and a locked lane must not receive content any more than it may lose it —
 *  the renderer's drop placement already refuses locked lanes for the same
 *  reason. */
export function pickFreeOverlayTrack(c: Composition, t0: number, t1: number): Uuid | null {
  const tracks = [...c.tracks].reverse()
  for (const t of tracks) {
    if (t.role !== null || t.locked) continue
    const free = t.layers.every((l) => !(t0 < l.t_end_us && l.t_start_us < t1))
    if (free) return t.id
  }
  return null
}

/** Remove a layer from every link; auto-dissolve below 2. */
export function dropLayerFromLinks(c: Composition, layerId: Uuid): void {
  let i = 0
  while (i < c.links.length) {
    const g = c.links[i]
    if (g.members.includes(layerId)) {
      g.members = g.members.filter((m) => m !== layerId)
      if (g.members.length < 2) { c.links.splice(i, 1); continue }
    }
    i++
  }
}

/** Links and transitions follow the SET across a composition boundary — the
 *  half pre-compose and the crossing primitive share (ungroup CLONES instead,
 *  so it has no use for this). A link or transition whose every member is in
 *  `memberSet` moves to `to` keeping its id; a link straddling the boundary
 *  loses its inside members and dissolves below two; a straddling transition is
 *  left in `from` for `reconcileTransitions` to drop and the actor to log — the
 *  drop rule has one home, and the commit runs it anyway. Markers are never
 *  touched: they mark a composition's own time, not the layers that left it. */
export function moveLinksAndTransitions(from: Composition, to: Composition, memberSet: ReadonlySet<Uuid>): void {
  for (let i = 0; i < from.links.length;) {
    const link = from.links[i]
    const inside = link.members.filter((m) => memberSet.has(m)).length
    if (inside === link.members.length) { to.links.push(link); from.links.splice(i, 1); continue }
    if (inside > 0) {
      link.members = link.members.filter((m) => !memberSet.has(m))
      if (link.members.length < 2) { from.links.splice(i, 1); continue }
    }
    i++
  }
  for (let i = 0; i < from.transitions.length;) {
    const tr = from.transitions[i]
    if (memberSet.has(tr.from_layer) && memberSet.has(tr.to_layer)) { to.transitions.push(tr); from.transitions.splice(i, 1); continue }
    i++
  }
}

/** Locked-track guard; missing layer → LayerNotFound. Returns the located
 *  layer so the caller edits what was checked. */
export function checkTrackLock(p: Project, id: Uuid): LocatedLayer {
  const found = requireLayer(p, id)
  if (found.track.locked) throw new CommandFailure({ error: 'TrackLocked', track: found.track.id })
  return found
}

/** Shift every animated track's keyframes by deltaUs (trim IN glues keyframes to
 *  content). */
export function shiftLayerKeyframes(params: LayerParams, deltaUs: number): void {
  forEachAnimatedF64(params, (a) => shiftKeyframes(a, deltaUs))
  forEachAnimatedRgba(params, (a) => shiftKeyframes(a, deltaUs))
}

/** The `src_in_us` / `src_out_us` family: the kinds whose timeline window is a
 *  window into a SOURCE — media for VideoClip / Audio, a composition for a
 *  Group layer (ADR 0052 §4) — so trim shifts the window edge, split divides it
 *  and a transition's tail borrow extends it. One predicate, because the three
 *  sites listing the kinds by hand is how CompositionRef was left out of each. */
export function hasSourceWindow(params: LayerParams): params is Extract<LayerParams, { src_out_us: number }> {
  return params.kind === 'VideoClip' || params.kind === 'Audio' || params.kind === 'CompositionRef'
}

/** The source duration a `src_out_us` may not exceed AT THE GESTURE: the media's
 *  probed duration, or the referenced composition's `duration_us`. Null when
 *  unknown (no probe, unknown media) or when the kind has no source window.
 *  For a Group layer this is a gesture bound only — validate puts no upper
 *  bound on the window (overhang, ADR 0052 §6). */
export function sourceDurationUs(p: Project, params: LayerParams): number | null {
  if (params.kind === 'VideoClip' || params.kind === 'Audio') return p.media_pool[params.media]?.metadata.duration_us ?? null
  if (params.kind === 'CompositionRef') return p.compositions[params.composition]?.duration_us ?? null
  return null
}
