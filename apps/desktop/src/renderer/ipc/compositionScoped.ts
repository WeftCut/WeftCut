// Creation channels stamped with the OPEN composition.
//
// The main side scopes every creation op by an optional `compositionId`
// (absent = root; `main/state/commands.ts`, `actor.ts` `wireCompositionId`).
// The UI's creation gestures — Insert menu, marker key, media-pool drop, the
// composition settings form — mean "here, in the timeline I am looking at", so
// these wrappers read the scope store at call time and pass its id along. The
// unscoped wrappers in `./index.ts` keep their root meaning for callers that
// want the root regardless (the e2e export hooks).
//
// Layer-addressed channels carry no composition: the layer id names it
// (ADR 0052), so nothing here wraps `update_layer`, `move_layer` and friends.

import { invoke } from "@/bridge/ipc";
import type { CompositionPatchPartial, Rgba } from "./index";
import { focusedCompositionId } from "../state/compositionAnchorStore";

/// `add_track` in the open composition. Tracks are kind-agnostic.
export async function addTrackInOpenComposition(): Promise<string> {
  return invoke<string>("add_track", { compositionId: focusedCompositionId() });
}

/// `add_marker` at `tUs` on the open composition's timeline; the label is
/// deliberately empty (see `addMarkerAt`).
export async function addMarkerAtInOpenComposition(tUs: number): Promise<string> {
  return invoke<string>("add_marker", {
    tUs,
    label: "",
    compositionId: focusedCompositionId(),
  });
}

export async function addColorLayerInOpenComposition(opts: {
  tStartUs: number;
  durationUs?: number;
  trackId?: string;
  color?: Rgba;
  width?: number;
  height?: number;
}): Promise<string> {
  return invoke<string>("add_color_layer", {
    trackId: opts.trackId,
    color: opts.color,
    width: opts.width,
    height: opts.height,
    tStartUs: opts.tStartUs,
    durationUs: opts.durationUs,
    compositionId: focusedCompositionId(),
  });
}

export async function addTextLayerInOpenComposition(opts: {
  tStartUs: number;
  durationUs?: number;
  trackId?: string;
  content?: string;
}): Promise<string> {
  return invoke<string>("add_text_layer", {
    trackId: opts.trackId,
    content: opts.content,
    tStartUs: opts.tStartUs,
    durationUs: opts.durationUs,
    compositionId: focusedCompositionId(),
  });
}

/// `add_group_layer`: place an existing composition on `trackId` as one Group
/// clip, windowed over the whole composition. The track already fixes which
/// composition receives it — the open id rides along as the cross-check that
/// catches a lane resolved before the user left for another timeline.
///
/// Refused with `CompositionCycle` when the composition would contain itself;
/// the drop target greys the same case out first (`mediaDrag.ts`).
export async function addGroupLayerInOpenComposition(args: {
  sourceCompositionId: string;
  trackId: string;
  tStartUs: number;
}): Promise<string> {
  return invoke<string>("add_group_layer", {
    sourceCompositionId: args.sourceCompositionId,
    trackId: args.trackId,
    tStartUs: args.tStartUs,
    compositionId: focusedCompositionId(),
  });
}

/// `add_motif` with the auto-spawned track (no `trackId`) opening in the open
/// composition. With a `trackId` the track fixes the composition and the id is
/// a cross-check the actor performs.
export async function addMotifInOpenComposition(args: {
  motifId: string;
  tStartUs: number;
  tEndUs?: number;
  trackId?: string | undefined;
  props?: Record<string, unknown>;
}): Promise<string> {
  return invoke<string>("add_motif", {
    motifId: args.motifId,
    tStartUs: args.tStartUs,
    tEndUs: args.tEndUs,
    trackId: args.trackId,
    props: args.props,
    compositionId: focusedCompositionId(),
  });
}

/// `set_composition` on a NAMED composition — the settings form edits the
/// canvas of the composition it displays, which is the open one. The lattice
/// fields (fps / sample_rate / channels) cascade to every composition whichever
/// is named (ADR 0052 §5).
export async function setCompositionOf(
  compositionId: string,
  patch: CompositionPatchPartial,
): Promise<void> {
  return invoke<void>("set_composition", { patch, compositionId });
}

/// `fit_composition_to_layers` on a named composition.
export async function fitCompositionToLayersOf(compositionId: string): Promise<void> {
  return invoke<void>("fit_composition_to_layers", { compositionId });
}
