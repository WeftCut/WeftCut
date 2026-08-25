// The playback-resolution glyphs: one landscape frame, one corner block, three
// sizes.
//
// Drawn here rather than picked from lucide because no stock icon says "the
// preview ships at 1/2". The previous SignalHigh/Medium/Low ladder said "more"
// and "less" — true, but it named the wrong quantity, and once the three strip
// buttons collapsed into one cycling button the glyph became the ONLY thing
// carrying the current value.
//
// Why geometry and not the literal text "full" / "1/2" / "1/4": the strip's
// icon box is 16 px. At the 24-unit viewBox that is a scale of 2/3, so a
// three-character string needs ~11 px of width against a corner badge with ~8
// px to give, and "full" needs ~15 px. Text does not fit; the value has to be
// drawn. It IS drawn where the text would have gone.
//
// LANDMINE: the block is the fraction the LABEL names, by AREA — not the
// fraction the decoder applies. `playbackScaleDiv` divides both axes, so
// "quarter" ships 1/4 of the width and 1/4 of the height: one SIXTEENTH of the
// frame. Drawing that is arithmetically faithful and reads as a bug — a speck
// in the corner of a button whose tooltip says "1/4". The glyph agrees with the
// word next to it instead, so linear scale is √fraction and the quarter block
// is exactly the bottom-right quadrant. Anyone tempted to "fix" this back to
// the divisor should re-read this paragraph.

import type { SVGProps } from "react";

/** A landscape frame, because that is the shape of the thing whose resolution
 *  this is. Lucide's own 20×14 monitor box, so the glyph sits on the same grid
 *  as its neighbours in the strip: 24-unit viewBox, 2-wide centred stroke. */
const FRAME = { x: 2, y: 5, width: 20, height: 14, rx: 2 } as const;

/** The region a block may occupy: inside the frame's stroke (which is centred
 *  on the path, so it covers 1..3 / 21..23 and 4..6 / 18..20) plus one unit of
 *  air, so the block cannot fuse with the frame at 16 px. Blocks are anchored
 *  to its bottom-right corner and scaled from there. */
const FILL = { left: 4, top: 7, right: 20, bottom: 17 } as const;
const FILL_WIDTH = FILL.right - FILL.left;
const FILL_HEIGHT = FILL.bottom - FILL.top;

type GlyphProps = { size?: number | string } & Omit<
  SVGProps<SVGSVGElement>,
  "size"
>;

/**
 * A glyph whose block covers `fraction` of the fill region, pinned to its
 * bottom-right corner — so every rung is a scaled copy of that region, and the
 * block stays landscape like the frame around it rather than becoming a square
 * inside a rectangle.
 *
 * A factory called at module scope, NOT inside a render: `resolveIcon` returns
 * one of these per state, and a component identity minted per render would
 * unmount and remount the `<svg>` on every strip re-render.
 */
function playbackResolutionGlyph(fraction: number, name: string) {
  // Area → linear. Halving the area shrinks each side by √2, which is what
  // keeps "1/2" visibly between "full" and "1/4" instead of collapsing toward
  // one end of the ladder.
  const scale = Math.sqrt(fraction);
  const width = FILL_WIDTH * scale;
  const height = FILL_HEIGHT * scale;
  // The corner radius tracks the block's short axis, so the smallest rung stays
  // a rectangle with softened corners rather than rounding into a lozenge.
  const radius = Math.min(1, height / 6);
  const Glyph = ({ size = 24, ...rest }: GlyphProps) => (
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
      <rect {...FRAME} />
      {/* Filled, and explicitly stroke-less: it inherits the frame's 2-wide
          stroke otherwise, which at the quarter size is half the block again. */}
      <rect
        x={FILL.right - width}
        y={FILL.bottom - height}
        width={width}
        height={height}
        rx={radius}
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
  Glyph.displayName = name;
  return Glyph;
}

/** The block fills the frame — nothing is being thrown away. */
export const PlaybackResolutionFullIcon = playbackResolutionGlyph(
  1,
  "PlaybackResolutionFullIcon",
);

/** Half the frame's area: √2 smaller on each side. */
export const PlaybackResolutionHalfIcon = playbackResolutionGlyph(
  1 / 2,
  "PlaybackResolutionHalfIcon",
);

/** A quarter of the frame's area, which lands exactly on the bottom-right
 *  quadrant — the smallest rung, and the one the ladder is read from. */
export const PlaybackResolutionQuarterIcon = playbackResolutionGlyph(
  1 / 4,
  "PlaybackResolutionQuarterIcon",
);
