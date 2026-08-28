import type { ProjectSummary } from "../ipc";
import { groupDisplayName } from "../lib/layerName";

/// One row of the media pool's Groups section.
export interface GroupPoolRow {
  compositionId: string;
  /// The name the row shows. The SAME `groupDisplayName` the timeline clip and
  /// the tab use, not a second derivation — a pool row and the clip it
  /// places have to read as one thing, and "Group 2" in the pool beside "Group 3"
  /// on the timeline is the failure that makes reuse unusable.
  name: string;
  durationUs: number;
  /// How many Group clips point at this composition. `0` is an orphan — legal,
  /// and the reason this section exists (ADR 0042 refused leaving state with an
  /// entity no surface can remove).
  refCount: number;
}

/// Every composition except the root, in the summary's own key order — which is
/// main's insertion order, so the rows are in creation order and the derived
/// `Group N` numbers run down the list.
///
/// `ordinals` and `refCounts` come from the project store, indexed once per
/// summary; passing them in rather than deriving them here keeps this a pure
/// function of its arguments and keeps the per-summary work out of the render.
export function groupPoolRows(
  summary: ProjectSummary,
  ordinals: ReadonlyMap<string, number>,
  refCounts: ReadonlyMap<string, number>,
  t: (key: string, values: Record<string, unknown>) => string,
): GroupPoolRow[] {
  const rows: GroupPoolRow[] = [];
  for (const [id, comp] of Object.entries(summary.compositions)) {
    if (id === summary.root_id) continue;
    rows.push({
      compositionId: id,
      name: groupDisplayName(id, comp.label, ordinals, t),
      durationUs: comp.duration_us,
      refCount: refCounts.get(id) ?? 0,
    });
  }
  return rows;
}

/// Case-insensitive substring match on the displayed name — the same rule the
/// media list's own filter uses, so one search box governs both sections.
export function filterGroupPoolRows(
  rows: readonly GroupPoolRow[],
  query: string,
): GroupPoolRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((r) => r.name.toLowerCase().includes(needle));
}
