import { current, isDraft } from 'immer'
import type { Composition, Layer, LayerParams, Project, Uuid } from '../model'
import { rootComposition } from '../model'
import { CommandFailure } from '../errors'
import { frameGrid, snapUpOnGrid } from '../snap'
import { forEachAnimatedF64, forEachAnimatedRgba, shiftKeyframes } from './animated'

/** Deep-clone a layer whether it came from an Immer recipe or plain test data. */
export function cloneLayer(layer: Layer): Layer {
  return structuredClone(isDraft(layer) ? current(layer) : layer)
}

/** The composition every mutation in this directory edits. Layer-addressed ops
 *  address the ROOT: nothing but a hand-written file can place a layer in a
 *  Group yet, so `rootComposition` is the one scope rule, spelled as a call so
 *  the sweep that derives the scope from the layer id later is
 *  `rg 'rootComposition\(' mutations` and nothing else. */
export { rootComposition } from '../model'

/** `p.compositions[id]` or CompositionNotFound. */
export function compositionOf(p: Project, id: Uuid): Composition {
  const c = p.compositions[id]
  if (!c) throw new CommandFailure({ error: 'CompositionNotFound', composition: id })
  return c
}

/** (track index, layer index) of a layer in the ROOT composition, or null. */
export function locateLayer(p: Project, id: Uuid): [number, number] | null {
  return locateLayerIn(rootComposition(p), id)
}

export function locateLayerIn(c: Composition, id: Uuid): [number, number] | null {
  for (let ti = 0; ti < c.tracks.length; ti++) {
    const li = c.tracks[ti].layers.findIndex((l) => l.id === id)
    if (li >= 0) return [ti, li]
  }
  return null
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

/** Locked-track guard; missing layer → LayerNotFound. */
export function checkTrackLock(p: Project, id: Uuid): void {
  const c = rootComposition(p)
  const loc = locateLayerIn(c, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const track = c.tracks[loc[0]]
  if (track.locked) throw new CommandFailure({ error: 'TrackLocked', track: track.id })
}

/** Shift every animated track's keyframes by deltaUs (trim IN glues keyframes to
 *  content). */
export function shiftLayerKeyframes(params: LayerParams, deltaUs: number): void {
  forEachAnimatedF64(params, (a) => shiftKeyframes(a, deltaUs))
  forEachAnimatedRgba(params, (a) => shiftKeyframes(a, deltaUs))
}
