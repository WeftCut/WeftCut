// Creation channels that are TOLD which composition receives them.
//
// The main side scopes every creation op by an optional `compositionId`
// (absent = root; `main/state/commands.ts`, `actor.ts` `wireCompositionId`).
// Here that id is a required argument, never a store read: several timeline
// Panels stand open at once and the preview may draw a third composition
// entirely, so "here, in the timeline I am looking at" is a guess — and what it
// guesses wrong is where the user's media lands. The gesture names the
// destination instead (ADR 0053 decision 4): a drop passes the Panel it landed
// on, a shortcut, menu item or Quick Action passes the Panel holding the
// keyboard, read at event time. `null` names the ROOT, which is what the
// unbound timeline row the Dock builds before the first summary is.
//
// A `trackId` was never ambiguous — a track id is unique project-wide, so the
// track alone fixes the destination and the composition rides along as the
// cross-check the actor performs. It still has to be the RIGHT one: naming a
// composition the track does not belong to is refused (`InvalidArgument`),
// which is exactly what a store read would produce for a drop into a Panel
// that does not hold the keyboard.
//
// The unscoped wrappers in `./index.ts` keep their root meaning for callers
// that want the root regardless (the e2e export hooks).
//
// Layer-addressed channels carry no composition: the layer id names it
// (ADR 0052), so nothing here wraps `update_layer`, `move_layer` and friends.

import { invoke } from "@/bridge/ipc";
import type { CompositionPatchPartial, MarkerAnchorArg, Rgba } from "./index";

/// `add_track` in `compositionId`. Tracks are kind-agnostic.
export async function addTrackIn(compositionId: string | null): Promise<string> {
  return invoke<string>("add_track", { compositionId });
}

/// `add_marker` at `tUs` on `compositionId`'s timeline; the label is
/// deliberately empty (see `addMarkerAt`).
///
/// `anchor` ties the new marker to a clip of that same composition inside the
/// ONE commit that creates it. An optional argument rather than a second
/// wrapper because free and anchored are one gesture: `M` decides which it is
/// from the selection at press time, and a caller that has to pick between two
/// functions is a caller writing that branch twice. Adding then attaching would
/// also put an undo step between a marker and the clip it was born on.
/// `src_us` is the caller's to derive (`markerAnchorFor`, timeline/markerAtFrame);
/// the actor takes the pair on trust and the commit's reconcile derives `t_us`
/// straight back from it.
export async function addMarkerAtIn(
  compositionId: string | null,
  tUs: number,
  anchor?: MarkerAnchorArg | null,
): Promise<string> {
  return invoke<string>("add_marker", {
    tUs,
    label: "",
    compositionId,
    anchor: anchor ?? null,
  });
}

export async function addColorLayerIn(opts: {
  compositionId: string | null;
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
    compositionId: opts.compositionId,
  });
}

export async function addTextLayerIn(opts: {
  compositionId: string | null;
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
    compositionId: opts.compositionId,
  });
}

/// `add_group_layer`: place an existing composition on `trackId` as one Group
/// clip, windowed over the whole composition.
///
/// Refused with `CompositionCycle` when the composition would contain itself;
/// the drop target greys the same case out first (`mediaDrag.ts`).
export async function addGroupLayerIn(args: {
  compositionId: string | null;
  sourceCompositionId: string;
  trackId: string;
  tStartUs: number;
}): Promise<string> {
  return invoke<string>("add_group_layer", {
    sourceCompositionId: args.sourceCompositionId,
    trackId: args.trackId,
    tStartUs: args.tStartUs,
    compositionId: args.compositionId,
  });
}

/// `add_motif`. Without a `trackId` the actor spawns a fresh overlay track in
/// `compositionId`, which is the path that needs the id to route at all.
export async function addMotifIn(args: {
  compositionId: string | null;
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
    compositionId: args.compositionId,
  });
}

/// `set_composition` on a NAMED composition — the settings form edits the
/// canvas of the composition it displays. The lattice fields (fps / sample_rate
/// / channels) cascade to every composition whichever is named (ADR 0052 §5).
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
