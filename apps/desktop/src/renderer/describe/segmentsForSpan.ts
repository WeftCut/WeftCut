// The one join between a described source and a reviewed shot: a time
// intersection, and nothing more.
//
// `describe_clip` timestamps its segments in source-absolute microseconds and a
// `ShotRow` carries its span in the same domain, so there is no mapping step
// here and deliberately no place for one to appear.

import type { DescSegment } from "../ipc";

/// Every segment whose span overlaps `[srcStartUs, srcEndUs)`, in time order.
///
/// A segment that STRADDLES two shots belongs to both. The model sampled across
/// a boundary the detector found — the two disagree about where the content
/// changes, which is exactly the correlation a reviewer is here to see — and
/// dropping the segment or clipping its prose to the row's edge would hide that
/// disagreement rather than show it.
///
/// Half-open on both sides of the comparison (`start < end && end > start`),
/// which is the same predicate Rust's `DescriptionCache::segments_in` uses: a
/// segment that merely touches an edge belongs to the row it lies inside.
export function segmentsForSpan(
  segments: readonly DescSegment[] | null,
  srcStartUs: number,
  srcEndUs: number,
): readonly DescSegment[] {
  if (segments === null) return [];
  return segments
    .filter((s) => s.t_start_us < srcEndUs && s.t_end_us > srcStartUs)
    .sort((a, b) => a.t_start_us - b.t_start_us);
}
