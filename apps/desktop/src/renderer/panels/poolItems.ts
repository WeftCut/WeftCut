// The media pool's list, built from its two sources.
//
// Owns what a pool entry IS and the order entries come in; owns nothing about
// how a card draws (`panels/MediaPool.tsx`) and nothing about where a
// composition's name comes from (`lib/layerName.ts`).

import type { MediaSummary, ProjectSummary } from "../ipc";
import { groupDisplayName } from "../lib/layerName";

/// A media item as the pool holds it. `media` rides along whole because the
/// card needs the readiness, kind and thumbnail fields the list has no opinion
/// about.
export interface MediaPoolItem {
  kind: "media";
  id: string;
  name: string;
  media: MediaSummary;
}

/// A Group as the pool holds it.
export interface GroupPoolItem {
  kind: "group";
  id: string;
  /// The SAME `groupDisplayName` the timeline clip and the tab use, not a second
  /// derivation — a pool card and the clip it places have to read as one thing,
  /// and "Group 2" in the pool beside "Group 3" on the timeline is the failure
  /// that makes reuse unusable.
  name: string;
  /// The composition's own length. `0` means there is nothing to window, so the
  /// card refuses the drag rather than letting the commit refuse the drop.
  durationUs: number;
  /// How many Group clips point at this composition. `0` is an isolated
  /// composition — legal, and the reason it must keep a card at all: ADR 0042
  /// refused leaving state with an entity no surface can remove.
  refCount: number;
}

/// One entry of the pool's single list. A Group and a media item are the same
/// kind of thing to that Panel — a source dragged onto a timeline — so they
/// share one list, one layout switch and one card skin, and differ only in what
/// the card draws and what the drag carries.
export type PoolItem = MediaPoolItem | GroupPoolItem;

/// The pool's name order. `numeric` is the whole point: without it `Group 10`
/// sorts before `Group 2`, which makes a derived name useless as a finding aid.
/// Build one per locale and reuse it — a collator constructed per comparison is
/// the expensive way to spell `localeCompare`.
export function poolCollator(locale: string): Intl.Collator {
  return new Intl.Collator(locale, { numeric: true });
}

/// Every composition except the root, in the summary's own key order.
///
/// Split out from the merged list because the preview Panel's render-target list
/// names and marks compositions the same way and must not grow a second
/// derivation (`preview/previewTargetOptions.ts`); it keeps this order, while
/// the pool sorts.
///
/// `ordinals` and `refCounts` come from the project store, indexed once per
/// summary; passing them in rather than deriving them here keeps this a pure
/// function of its arguments and keeps the per-summary work out of the render.
export function groupPoolItems(
  summary: ProjectSummary,
  ordinals: ReadonlyMap<string, number>,
  refCounts: ReadonlyMap<string, number>,
  t: (key: string, values: Record<string, unknown>) => string,
): GroupPoolItem[] {
  const items: GroupPoolItem[] = [];
  for (const [id, comp] of Object.entries(summary.compositions)) {
    if (id === summary.root_id) continue;
    items.push({
      kind: "group",
      id,
      name: groupDisplayName(id, comp.label, ordinals, t),
      durationUs: comp.duration_us,
      refCount: refCounts.get(id) ?? 0,
    });
  }
  return items;
}

/// The whole pool, both kinds interleaved and sorted by the name each card
/// shows. Media arrive as the Panel's prop; compositions come from the project
/// store, which is a different set the Panel is never handed.
///
/// Ties break on id so a re-render never reshuffles two identically named cards.
export function poolItems(
  media: readonly MediaSummary[],
  summary: ProjectSummary | null,
  ordinals: ReadonlyMap<string, number>,
  refCounts: ReadonlyMap<string, number>,
  t: (key: string, values: Record<string, unknown>) => string,
  collator: Intl.Collator,
): PoolItem[] {
  const items: PoolItem[] = media.map((m) => ({
    kind: "media",
    id: m.id,
    name: m.label,
    media: m,
  }));
  if (summary) items.push(...groupPoolItems(summary, ordinals, refCounts, t));
  return items.sort(
    (a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/// Case-insensitive substring match on the displayed name — one search box,
/// one rule, both kinds.
export function filterPoolItems(
  items: readonly PoolItem[],
  query: string,
): PoolItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => item.name.toLowerCase().includes(needle));
}
