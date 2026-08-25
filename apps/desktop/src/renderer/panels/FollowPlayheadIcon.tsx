// The timeline auto-scroll glyph: a lane, and the playhead riding it.
//
// Hand-drawn for `PlaybackResolutionIcon.tsx`'s reason — lucide has no glyph
// for this value — but the failure it replaces was a different one. The button
// wore `LocateFixed`, a GPS reticle, chosen to say "keep the target centred".
// `followPlayhead.ts` does not centre: it PAGES, parking the playhead a lead
// margin (8% of the viewport) in from an edge and leaving it alone until it
// reaches the other one. The reticle drew a behaviour the code never had, and
// once the label became "Timeline auto-scroll" the picture was the last surface
// still naming a target rather than the view that moves.
//
// Two elements, and the second one is the whole design problem: the strip
// already spends `SquareSplitHorizontal` on "box crossed by a vertical line"
// three buttons away, and at 16 px a button conveys silhouette, not detail. So
// this glyph separates from that one twice over — the box is a wide flat LANE
// (20x10) where split's is a tall square, and the line stands left of centre
// where split's is dead centre. Either difference alone would blur at size;
// together they read apart at a glance.
//
// LANDMINE for anyone tempted to centre that line: its offset is the state
// auto-scroll actually leaves behind. After a page the playhead sits near the
// leading edge with a screenful of runway ahead, which is the thing the button
// buys. Centring it draws the one arrangement paging never produces, and
// revives the reticle's claim in a new shape.

import type { SVGProps } from "react";

/** The timeline's proportions, not the preview's. `PlaybackResolutionIcon`
 *  draws a 20x14 monitor because resolution is a property of a FRAME; this
 *  draws a 20x10 lane because auto-scroll is a property of a strip of track.
 *  Deliberately NOT a shared constant with that file — the two custom glyphs
 *  living in one strip is exactly why their boxes must differ. */
const LANE = { x: 2, y: 7, width: 20, height: 10, rx: 2 } as const;

/** Left of the 24-unit grid's centre by 4, which is ~2.7 px at the strip's
 *  16 px — far enough to read as placement rather than as a misaligned line.
 *  A 3-unit offset renders at 2 px and reads as a bug. */
const PLAYHEAD_X = 8;

/** How far the playhead runs past the lane, top and bottom. The real one
 *  overhangs its lane the same way, and the overhang is also what stops the
 *  line from reading as an interior divider — the split glyph's job. */
const PLAYHEAD_OVERHANG = 2;

type GlyphProps = { size?: number | string } & Omit<
  SVGProps<SVGSVGElement>,
  "size"
>;

/**
 * A lane with the playhead standing in it, off to the leading side.
 *
 * One fixed glyph, no `iconFor` pair: this is a plain on/off switch whose state
 * the strip's pressed styling and `aria-pressed` already carry, and a crossed-
 * out variant would restate at 16 px what the button already says — the same
 * rule the marker and snap toggles beside it follow.
 */
export const FollowPlayheadIcon = ({ size = 24, ...rest }: GlyphProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...rest}
  >
    <rect {...LANE} />
    <line
      x1={PLAYHEAD_X}
      x2={PLAYHEAD_X}
      y1={LANE.y - PLAYHEAD_OVERHANG}
      y2={LANE.y + LANE.height + PLAYHEAD_OVERHANG}
    />
  </svg>
);

FollowPlayheadIcon.displayName = "FollowPlayheadIcon";
