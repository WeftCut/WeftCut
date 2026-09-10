// The candidate pauses a detection found, drawn on the subject Audio clip: one
// translucent amber band per pause, with a darker core over the part *Remove*
// would actually cut and a brighter range while the audition is playing that
// join.
//
// Boundary: draws, and takes no press — the detection, its parameters and the
// audition belong to the Pauses section of the Attribute Panel, which publishes
// through `state/pausePreviewStore`, and the px↔µs arithmetic to
// `audioRegionGeometry.ts`, shared with the denoise region so the two bands on
// one clip cannot drift apart. See `.scratch/pauses/spec.md` Decisions 5 and 7.

import { Fragment } from "react";

import { usePausePreview } from "../state/pausePreviewStore";
import {
  pxFromCompUs,
  regionVisibility,
  type RegionPxContext,
} from "./audioRegionGeometry";

/// The three tones, spelled out literally because Tailwind's source scan reads
/// the file as text and never sees a composed class name.
///
/// All one amber — `rgb(230 160 40)`, the colour *Mark pauses* writes onto the
/// marker — so a band and the mark it can become read as the same fact. No ramp
/// shade IS that hue, hence the arbitrary value rather than `amber-500`.
const RANGE_CLASS = "bg-[#e6a028]/25";
const CORE_CLASS = "bg-[#e6a028]/50";
const AUDITIONING_CLASS =
  "bg-[#e6a028]/60 outline outline-1 -outline-offset-1 outline-[#e6a028]";

/// Where a span draws on the block, or `null` when it has no length or none of
/// it is on screen.
///
/// The clamp is not decoration: a trim or move preview moves the block's edges
/// under bands measured on the committed span, and the block has no
/// `overflow-hidden` to catch what hangs off.
function bandRect(
  inUs: number,
  outUs: number,
  loUs: number,
  hiUs: number,
  px: RegionPxContext,
): { left: number; width: number } | null {
  if (outUs <= inUs) return null;
  if (
    regionVisibility({ inUs, outUs, visibleLoUs: loUs, visibleHiUs: hiUs }) ===
    "offscreen"
  ) {
    return null;
  }
  const x0 = pxFromCompUs(Math.max(inUs, loUs), px);
  const x1 = pxFromCompUs(Math.min(outUs, hiUs), px);
  // A floor of one pixel: a 200 ms core on a zoomed-out timeline is a fraction
  // of a pixel wide, and a band nobody can see answers nothing.
  return { left: Math.min(x0, x1), width: Math.max(1, Math.abs(x1 - x0)) };
}

export function PauseBands({
  layerId,
  pxPerSec,
  blockLeftPx,
  tStartUs,
  blockLoUs,
  blockHiUs,
}: {
  /// This block's layer. The store names ONE subject Audio layer, so asking by
  /// id is also what keeps a delegating VideoClip, the ruler and the other link
  /// members blank.
  layerId: string;
  pxPerSec: number;
  /// Where the clip's `tStartUs` sits on the axis these bands are measured
  /// against — the same offset `AudioRegionBand` takes, and 0 whenever no
  /// gesture is moving the block's left edge off the committed head.
  blockLeftPx: number;
  tStartUs: number;
  /// The block's LIVE span in composition µs, which a trim or move preview
  /// narrows while the published pauses still describe the committed one.
  blockLoUs: number;
  blockHiUs: number;
}) {
  // Atomic by layer: the selector answers the stored object for the subject and
  // `null` for everyone else, so a detection landing re-renders one clip.
  const preview = usePausePreview(layerId);
  if (preview === null) return null;

  const px: RegionPxContext = { pxPerSec, blockLeftPx, tStartUs };
  const auditioning = new Set<number>(preview.auditioning);

  return (
    <div
      data-testid="pause-bands"
      // Inert and unannounced: the waveform underneath is what the eye checks,
      // and the denoise region's handles (z-[3]) must keep every press.
      className="pointer-events-none absolute inset-0 z-[1]"
      aria-hidden="true"
    >
      {preview.pauses.map((pause, index) => {
        const range = bandRect(
          pause.t_start_us,
          pause.t_end_us,
          blockLoUs,
          blockHiUs,
          px,
        );
        if (range === null) return null;
        // The pad is kept on EACH side, so a pause whose core collapses is one
        // *Remove* leaves alone — and it draws no core to say so.
        const core = bandRect(
          pause.t_start_us + preview.padUs,
          pause.t_end_us - preview.padUs,
          blockLoUs,
          blockHiUs,
          px,
        );
        return (
          // The index IS the identity here: it is what `auditioning` names.
          <Fragment key={index}>
            <div
              data-testid="pause-band"
              data-pause-index={index}
              className={`absolute inset-y-0 ${
                auditioning.has(index) ? AUDITIONING_CLASS : RANGE_CLASS
              }`}
              style={{ left: range.left, width: range.width }}
            />
            {core !== null && (
              <div
                data-testid="pause-band-core"
                data-pause-index={index}
                className={`absolute inset-y-0 ${CORE_CLASS}`}
                style={{ left: core.left, width: core.width }}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
