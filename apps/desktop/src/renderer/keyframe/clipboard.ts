// The app's ONE copy slot, holding either a clip or a set of keyframes.
//
// One slot rather than two, because Ctrl+C and Ctrl+V are one pair of keys: two
// slots would make the same paste land a clip or a keyframe depending on state
// the user cannot see, and "whichever I copied last" is the only rule that
// needs no display. Copying either kind therefore overwrites the other.
//
// A keyframe copy is a serialized SNAPSHOT, never ids into the project: the
// clips it came from can be trimmed, re-keyed or deleted before the paste, and
// a snapshot is what makes the paste independent of all of it. Layer identity is
// dropped and the groups are keyed by `paramKey` alone — the paste target is
// whatever is selected then, and the property is the only thing the two ends
// have to agree on. Times are rebased so the earliest key is 0, on the
// COMPOSITION clock, so a selection spanning layers keeps its shape.
//
// Transient by design: not persisted, not undoable, and not the OS clipboard —
// there is no interchange format for a keyframe record.
import { create } from "zustand";

import { HOLD_EXTRAPOLATION, cloneKeyframeShape } from "../../shared/keyframe";
import { logMutationFailure } from "../errors/tryMutate";
import type { AnimTrack, Keyframe, LayerSummary, TrackSummary } from "../ipc";
import { logEmit, updateParamTracksMulti } from "../ipc";
import { focusedPlayheadUs } from "../state/playheadProjection";
import { useProjectStore } from "../state/projectStore";
import { currentSelection, layerIdsOf } from "../state/selectionStore";
import {
  expandScaleFanOut,
  projectTracks,
  selectionGroups,
  type ParamTrackEntry,
} from "../timeline/keyframeBatch";
import { animatableParams, readParamTrack, scaleFanOutFor } from "./descriptors";
import type { TrackValue } from "./edits";
import {
  getSelectedKeyframes,
  setKeyframeSelection,
  type SelectedKeyframe,
} from "./selectionStore";

/// One property's worth of copied keys, ascending, rebased against the
/// snapshot's earliest key.
export interface KeyframeClipGroup {
  paramKey: string;
  keys: Keyframe<TrackValue>[];
}

export type ClipboardSlot =
  | { kind: "layer"; layerId: string }
  | { kind: "keyframes"; groups: KeyframeClipGroup[] };

interface State {
  slot: ClipboardSlot | null;
}

export const useClipboardStore = create<State>(() => ({ slot: null }));

export function clipboardSlot(): ClipboardSlot | null {
  return useClipboardStore.getState().slot;
}

export function copyLayer(layerId: string): void {
  useClipboardStore.setState({ slot: { kind: "layer", layerId } });
}

const newId = (): string => crypto.randomUUID();

/// The snapshot a keyframe copy stores. Ids are carried so a snapshot is a
/// faithful record of what was copied; every paste mints fresh ones, because
/// two pastes of one snapshot must not produce two keys claiming one identity.
export function keyframeSnapshot(args: {
  selected: readonly SelectedKeyframe[];
  tracks: readonly TrackSummary[];
}): KeyframeClipGroup[] {
  const byParam = new Map<string, { compUs: number; key: Keyframe<TrackValue> }[]>();
  let earliestUs = Infinity;
  for (const group of selectionGroups(args)) {
    const want = new Set(group.kfIds);
    for (const key of group.track.value) {
      if (!want.has(key.id)) continue;
      const compUs = group.layer.t_start_us + key.t_us;
      if (compUs < earliestUs) earliestUs = compUs;
      const bucket = byParam.get(group.paramKey);
      if (bucket) bucket.push({ compUs, key });
      else byParam.set(group.paramKey, [{ compUs, key }]);
    }
  }
  if (byParam.size === 0) return [];
  return [...byParam.entries()].map(([paramKey, entries]) => ({
    paramKey,
    keys: entries
      .sort((a, b) => a.compUs - b.compUs)
      .map(({ compUs, key }) => ({
        id: key.id,
        ...cloneKeyframeShape(key),
        t_us: compUs - earliestUs,
      })),
  }));
}

/// Snapshot the keyframe selection into the slot. `false` when nothing is
/// selected, which is the caller's signal to copy the clip instead.
export function copyKeyframes(args: {
  selected: readonly SelectedKeyframe[];
  tracks: readonly TrackSummary[];
}): boolean {
  const groups = keyframeSnapshot(args);
  if (groups.length === 0) return false;
  useClipboardStore.setState({ slot: { kind: "keyframes", groups } });
  return true;
}

export interface PasteResult {
  entries: ParamTrackEntry[];
  /// The keys the paste minted, for the selection it leaves behind — so the
  /// next gesture acts on what just landed.
  pasted: SelectedKeyframe[];
  /// Properties no target could take, for the one status-bar line.
  skipped: string[];
}

/// What pasting `groups` onto `layers` at `atUs` writes.
///
/// A Static target is LIFTED to a Keyframed track holding only the pasted keys:
/// the copied animation is the whole answer for that property, and folding the
/// old constant in as an extra key would invent a keyframe nobody authored. A
/// Keyframed target keeps its keys FIRST and takes the pasted ones LAST, which
/// is the same collision policy a batch retime uses — main's stable sort keeps
/// the last of a tied time, so a pasted key replaces the key it lands on.
///
/// Keys past the target's duration are retained, not clipped, the way trim and
/// split leave out-of-range keys alone: the clip can be re-extended.
export function pasteEntriesFor(args: {
  groups: readonly KeyframeClipGroup[];
  layers: readonly LayerSummary[];
  /// The paste point on the COMPOSITION clock; each layer converts through its
  /// own start.
  atUs: number;
  mkId?: () => string;
}): PasteResult {
  const mkId = args.mkId ?? newId;
  const pasted: SelectedKeyframe[] = [];
  const skipped = new Set<string>();
  // Keyed by (layer, target param) so two copied groups landing on one target
  // stack instead of overwriting each other — which is what a LINKED layer
  // does to the scale pair below.
  const byAddress = new Map<string, ParamTrackEntry>();
  for (const layer of args.layers) {
    const carried = new Set(animatableParams(layer.kind).map((d) => d.paramKey));
    for (const group of args.groups) {
      if (!carried.has(group.paramKey)) {
        skipped.add(group.paramKey);
        continue;
      }
      // A linked layer has ONE scale, so both axes of a copy land on the axis
      // the composite reads and the commit's fan-out writes the twin.
      const paramKey = scaleFanOutFor(group.paramKey, layer.params)?.[0] ?? group.paramKey;
      const address = `${layer.id}|${paramKey}`;
      const running = byAddress.get(address)?.[2] ?? readParamTrack(layer.params, paramKey);
      const keyed = running !== null && running.mode === "Keyframed" ? running : null;
      const offsetUs = args.atUs - layer.t_start_us;
      const fresh = group.keys.map((k) => {
        const id = mkId();
        pasted.push({ layerId: layer.id, paramKey, kfId: id });
        return { ...cloneKeyframeShape(k), id, t_us: offsetUs + k.t_us };
      });
      const next: AnimTrack<TrackValue> = {
        mode: "Keyframed",
        value: keyed === null ? fresh : [...keyed.value, ...fresh],
        extrapolate: keyed === null ? { ...HOLD_EXTRAPOLATION } : keyed.extrapolate,
      };
      byAddress.set(address, [layer.id, paramKey, next]);
    }
  }
  return { entries: [...byAddress.values()], pasted, skipped: [...skipped] };
}

/// Paste the slot's keyframes onto the selected clips at the focused timeline's
/// playhead, in ONE commit. `false` when nothing was written, which is the
/// caller's signal not to refresh.
///
/// A paste with no clip selected is REFUSED with a status-bar line rather than
/// a dialog or a toast: nothing is destroyed, the user's next move is one click
/// away, and the log is where this app says why a command declined (#18).
export async function pasteKeyframesAtPlayhead(
  groups: readonly KeyframeClipGroup[],
): Promise<boolean> {
  const { layerById } = useProjectStore.getState();
  const layers = [...layerIdsOf(currentSelection())]
    .map((id) => layerById.get(id))
    .filter((l): l is LayerSummary => l !== undefined);
  if (layers.length === 0) {
    void logEmit({
      level: "warn",
      category: { kind: "Project" },
      source: { kind: "User" },
      message: "Select a clip to paste keyframes onto",
      i18n_key: "log.paste_keyframes_no_target",
    });
    return false;
  }
  const { entries, pasted, skipped } = pasteEntriesFor({
    groups,
    layers,
    atUs: focusedPlayheadUs(),
  });
  if (skipped.length > 0) {
    void logEmit({
      level: "info",
      category: { kind: "Project" },
      source: { kind: "User" },
      message: `Skipped ${skipped.join(", ")} — the selected clips do not carry it`,
      i18n_key: "log.paste_keyframes_skipped",
      i18n_args: { params: skipped.join(", ") },
      details: { params: skipped.join(",") },
    });
  }
  if (entries.length === 0) return false;
  try {
    await updateParamTracksMulti(
      expandScaleFanOut(entries, (id) => layerById.get(id) ?? null),
    );
  } catch (e) {
    logMutationFailure(e, "Paste keyframes");
    return false;
  }
  setKeyframeSelection(pasted);
  return true;
}

/// The keyframe copy's own entry point, so the caller need not assemble the
/// selection and the project's tracks itself.
export function copySelectedKeyframes(): boolean {
  return copyKeyframes({
    selected: getSelectedKeyframes(),
    tracks: projectTracks(useProjectStore.getState().summary),
  });
}
