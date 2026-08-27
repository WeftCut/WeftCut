// Split every clip the playhead sits inside — the `Ctrl+K` of every NLE, and
// the keyboard / one-click half of the Blade tool, which can only ever cut
// where the pointer happens to be.
//
// Target resolution, in order:
//   1. the SELECTION, when anything in it straddles the playhead;
//   2. otherwise every straddling layer the user can currently see and edit.
// That is Premiere's contract — a selection narrows the cut to what you picked,
// no selection cuts everything under the line — and resolving in that order
// also keeps the common case (one clip, or one auto-paired A/V couple) to a
// SINGLE history entry.
//
// Reads its inputs live and holds no React state: it runs from a keyboard
// dispatch, from the Quick Actions strip and from the search palette, and none
// of those re-render App. Same rule `appCommands.ts` spells out for
// `clearRange`.

import { splitLayerLinked, type ProjectSummary } from "../ipc";
import { displayMode } from "../settings/appSettingsStore";
import { playheadTimeUs } from "../state/playheadStore";
import { useProjectStore } from "../state/projectStore";
import { useSelectionStore } from "../state/selectionStore";

/// One layer a cut would land in, paired with the link the cut fans out to
/// (null when the layer is unlinked). The link id exists only for the
/// dedupe in `resolveSplitTargets`.
export interface SplitTarget {
  layerId: string;
  linkId: string | null;
}

/**
 * The layers a split at `tUs` would cut, in track order.
 *
 * Four filters, each answering one refusal the actor would otherwise have to
 * make:
 *
 * - **Strict containment** (`t_start < tUs < t_end`). A cut on either edge is
 *   `SplitOutsideLayer`, and a frame-precise editor should never send one: the
 *   playhead resting exactly on a cut means there is nothing to split there.
 * - **Locks.** A locked layer or a locked track answers `TrackLocked`. A lock
 *   is the user's own standing instruction, so prevention beats reporting it
 *   back at them (#18).
 * - **One layer per link.** `split_layer_linked` with `escape_link: false`
 *   splits every spanning link sibling in the SAME commit, so sending the
 *   partner too would ask the actor to cut an interval it had just closed —
 *   `SplitOutsideLayer` on a clip that *did* get split. Deduping here is what
 *   keeps an auto-paired A/V couple one commit and one undo.
 * - **The A/B Roll filter, for the no-selection path only.** In `AbRoll` the
 *   timeline hides every role-less track (`TrackSummary.role`), which is
 *   exactly where auto-spawned overlays and titles land. Cutting a clip the
 *   user cannot see would be a silent edit, so the sweep stays inside the
 *   visible rows. The SELECTION path deliberately ignores the filter: a
 *   selected layer is one the user reached on purpose, and the timeline's
 *   inline reveal already shows it.
 */
export function resolveSplitTargets(
  summary: ProjectSummary,
  tUs: number,
  selected: ReadonlySet<string>,
  abRollFilter: boolean,
): SplitTarget[] {
  const linkOf = new Map<string, string>();
  for (const link of summary.links) {
    for (const layerId of link.layer_ids) linkOf.set(layerId, link.id);
  }

  // Built twice over the same tracks rather than once with a flag: the two
  // passes differ in their row filter, and the selection pass has to run to
  // completion before the fallback can be ruled out.
  const collect = (
    accept: (layerId: string) => boolean,
    rowVisible: (roleIsNull: boolean) => boolean,
  ): SplitTarget[] => {
    const out: SplitTarget[] = [];
    const claimedLinks = new Set<string>();
    for (const track of summary.tracks) {
      if (track.locked || !rowVisible(track.role === null)) continue;
      for (const layer of track.layers) {
        if (layer.locked) continue;
        if (!(layer.t_start_us < tUs && tUs < layer.t_end_us)) continue;
        if (!accept(layer.id)) continue;
        const linkId = linkOf.get(layer.id) ?? null;
        if (linkId !== null) {
          if (claimedLinks.has(linkId)) continue;
          claimedLinks.add(linkId);
        }
        out.push({ layerId: layer.id, linkId });
      }
    }
    return out;
  };

  const fromSelection = collect(
    (layerId) => selected.has(layerId),
    () => true,
  );
  if (fromSelection.length > 0) return fromSelection;
  return collect(
    () => true,
    (roleIsNull) => !abRollFilter || !roleIsNull,
  );
}

/**
 * Cut at the playhead.
 *
 * Silent when nothing straddles it — the same answer `deleteSelected` and
 * `handleToggleLinkSelected` give an empty target, and the honest one for a key
 * pressed over a gap.
 *
 * Rejections propagate: the registry and the keyboard dispatcher both funnel
 * `run` through `runCommandWithLogging`, which turns one into the single
 * `Shortcut`/Error row with the refusal's curated copy. A failure part-way
 * through a multi-clip cut therefore stops the loop, and the clips already
 * cut stay cut (each split is its own commit).
 *
 * LANDMINE: N straddling clips are N commits, so N undo steps. One commit
 * would need a new actor op — `split_layer_multi` splits one layer at many
 * times, which is the other axis. The target order above is what keeps the
 * common case at N = 1.
 */
export async function splitAtPlayhead(): Promise<void> {
  const summary = useProjectStore.getState().summary;
  if (!summary) return;
  // Read ONCE: the playhead moves under playback, and resolving the targets
  // against one instant and cutting at another would send a time that no
  // longer falls inside the clip the resolve picked.
  const tUs = playheadTimeUs();
  const targets = resolveSplitTargets(
    summary,
    tUs,
    useSelectionStore.getState().selectedLayerIds,
    displayMode() === "AbRoll",
  );
  for (const target of targets) {
    // `escape_link: false` — the link-aware split, exactly as the Blade
    // sends it, so a linked A/V pair cuts in lockstep.
    await splitLayerLinked(target.layerId, tUs, false);
  }
}
