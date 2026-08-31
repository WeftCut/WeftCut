// Shared primitives for the state-corpus property-based test suite.
// Every fc.assert in this suite passes { seed: PBT_SEED, numRuns: PBT_RUNS }
// so CI is deterministic and Stryker can shrink runs via WEFTCUT_PBT_RUNS.
import { seededGen } from '../../ids'
import { blankProject } from '../../model'
import { createActor } from '../../actor'
import { serializeProject } from '../../serialize'
import { canonicalString } from '../../canonical'
import { root } from '../fixtures/project'

export const PBT_SEED = 0x5747_4354 // "WGCT" — fixed; do not randomize.
export const PBT_RUNS = Number(process.env.WEFTCUT_PBT_RUNS ?? 200)

// `src_in_us` / `src_out_us` are present exactly on the source-window kinds
// (VideoClip, Audio, CompositionRef) — optional here rather than a second layer
// type, because the marker invariant is the only reader and it already has to
// answer "does this kind carry a window" for itself.
export interface WireLayer { id: string; t_start_us: number; t_end_us: number; params: { kind: string; src_in_us?: number; src_out_us?: number } }
export interface WireTrack { id: string; layers: WireLayer[] }
export interface WireLink { id: string; members: string[] }
export interface WireMarker { id: string; t_us: number; end_t_us: number | null; anchor?: { layer: string; src_us: number } | null }
export interface WireTransition { id: string; from_layer: string; to_layer: string; duration_us: number; kind: { kind: string; direction?: string }; extended_us: number }
export interface WireComposition {
  id: string
  duration_us: number; duration_pinned: boolean; fps: { num: number; den: number }; width: number; height: number
  tracks: WireTrack[]
  markers: WireMarker[]
  links: WireLink[]
  transitions: WireTransition[]
}
export interface WireProject { compositions: Record<string, WireComposition>; root_id: string }
export function wireRoot(w: WireProject): WireComposition { return w.compositions[w.root_id] }

/** Fresh blank project + actor with seeded ids (#1 A-roll, #2 B-roll, #3 project,
 *  #4 root composition). Clock is constant so timestamps never perturb canonical
 *  comparison. */
export function freshActor() {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'replay')
  return createActor({ initial, idGen, clock: () => '<TS>' })
}

export function aRollId(actor: ReturnType<typeof createActor>): string { return root(actor.snapshot()).tracks[0].id }
export function bRollId(actor: ReturnType<typeof createActor>): string { return root(actor.snapshot()).tracks[1].id }

export function wireSnapshot(actor: ReturnType<typeof createActor>): WireProject {
  return serializeProject(actor.snapshot()) as WireProject
}
export function canonicalSnapshot(actor: ReturnType<typeof createActor>): string {
  return canonicalString(serializeProject(actor.snapshot()))
}

