// The in/out marking glyphs: square brackets, opening toward the range.
//
// Hand-drawn for `PlaybackResolutionIcon.tsx`'s reason — lucide ships no single
// `[` or `]`, only `Brackets` with both halves fused into one glyph — but this
// set also has to clear a bar the stock arrows never did. The bracket IS the
// in/out mark in Premiere, Resolve, Final Cut and Avid alike; it is the most
// standardised glyph in the whole NLE vocabulary, and the buttons already teach
// the matching `I` / `O` accelerator in their tooltip. Borrowing the shape hands
// every user who has opened another editor a free read.
//
// The shape also has to survive being a MIRRORED PAIR at 16 px, which is where
// an arrow-plus-bar fails: mirroring a bar-and-arrowhead moves one element and
// leaves the silhouette identical, so the two buttons separate only under
// side-by-side comparison. A bracket mirrors into a genuinely different outline
// because its feet are asymmetric — they point INTO the range, so `[` reads as
// "the region starts here and runs right" without an arrow claiming travel.
//
// Distinct from the strip's other closed-box glyphs (`FollowPlayheadIcon`'s
// 20x10 lane, `SquareSplitHorizontal`'s square) by being open on one side: at
// button size the discriminator is "is this a box or a hook", which survives
// scaling in a way interior detail does not.

import type { ReactNode, SVGProps } from "react";

/** The vertical extent every glyph here shares. 16 of the 24 units, which
 *  leaves the 4 units of air lucide's own `Brackets` leaves and keeps the round
 *  caps clear of the viewBox edge under the 2-wide centred stroke. */
const SPINE = { top: 4, bottom: 20 } as const;

/** Matches `FollowPlayheadIcon`'s `LANE.rx`, so the two hand-drawn glyph
 *  families in this strip round their corners alike. */
const CORNER = 2;

/** How far a LONE bracket's feet reach from its spine. 10 units is ~6.7 px at
 *  the strip's 16 px — long enough that the feet survive as feet. Shorten this
 *  and the glyph degenerates into a plain vertical bar, which is exactly the
 *  failure the bracket was chosen to avoid. `CLEAR_FOOT` is allowed to be
 *  shorter for a reason stated at its own definition. */
const FOOT = 10;

/** The pair is centred on the 24-unit grid rather than pushed to its own side
 *  of the box. Placement is deliberately NOT a second differentiator here: the
 *  feet already carry the difference as shape, and an off-centre glyph reads as
 *  misaligned next to its centred neighbours in the strip. */
const SPINE_NEAR = 12 - FOOT / 2;
const SPINE_FAR = 12 + FOOT / 2;

/** Both spines of the clear glyph, retreated to the grid's edges to open a
 *  field for the cross between them. */
const CLEAR_LEFT = 4;
const CLEAR_RIGHT = 20;

/** The clear glyph's feet, well under `FOOT` and not a violation of it: a lone
 *  bracket has to establish "this is a bracket" by itself, whereas these two
 *  are read as a pair and each is the other's context. Lucide draws its own
 *  `Brackets` on the same 4 units for the same reason, and ships no single
 *  bracket at all. */
const CLEAR_FOOT = 4;

/** The cross's diagonal extent, centred on the grid. Sized by CLEARANCE, not by
 *  weight: at 8 units its corners come within 2 units of the bracket feet's
 *  round caps — 1.3 px at the strip's 16 px — and the two fuse into one blob.
 *  6 units holds a 3-unit gap. */
const CROSS = { min: 9, max: 15 } as const;
const CROSS_SPAN = CROSS.max - CROSS.min;

type GlyphProps = { size?: number | string } & Omit<
  SVGProps<SVGSVGElement>,
  "size"
>;

/** A bracket's outline, traced from its far foot around the spine to the other.
 *  Both arcs sweep positive — the same winding lucide's `Brackets` uses, so a
 *  bracket drawn here and one imported from the package curve identically. */
function bracketPath(side: "left" | "right", spine: number, foot: number) {
  return side === "left"
    ? `M${spine + foot} ${SPINE.bottom} H${spine + CORNER} a${CORNER} ${CORNER} 0 0 1 -${CORNER} -${CORNER} V${SPINE.top + CORNER} a${CORNER} ${CORNER} 0 0 1 ${CORNER} -${CORNER} H${spine + foot}`
    : `M${spine - foot} ${SPINE.top} H${spine - CORNER} a${CORNER} ${CORNER} 0 0 1 ${CORNER} ${CORNER} V${SPINE.bottom - CORNER} a${CORNER} ${CORNER} 0 0 1 -${CORNER} ${CORNER} H${spine - foot}`;
}

/**
 * An `<svg>` on lucide's grid wrapping `children`.
 *
 * A factory called at module scope, NOT inside a render, for the reason
 * `playbackResolutionGlyph` states: a component identity minted per render
 * remounts the `<svg>` on every strip re-render.
 */
function glyph(children: ReactNode, name: string) {
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
      {children}
    </svg>
  );
  Glyph.displayName = name;
  return Glyph;
}

/** `[` — the range opens here and runs to the right. */
export const MarkInIcon = glyph(
  <path d={bracketPath("left", SPINE_NEAR, FOOT)} />,
  "MarkInIcon",
);

/** `]` — the range closes here, having arrived from the left. */
export const MarkOutIcon = glyph(
  <path d={bracketPath("right", SPINE_FAR, FOOT)} />,
  "MarkOutIcon",
);

/**
 * `[ ]` struck through by a cross — both marks, removed.
 *
 * A cross and NOT lucide's diagonal `*Off` slash, because those two say
 * different things in lucide's own vocabulary: a slash means the thing is
 * switched off, an `X` badge means it is deleted (`CalendarX`, `BookmarkX`,
 * `FileX`). `clearRange` deletes, and it is a momentary command with no off
 * state to depict — the strip gives it neither `aria-pressed` nor pressed
 * styling. This glyph is also continuous with the plain `X` the button wore
 * before it: the same cross, now with a subject.
 *
 * Symmetric where the pair above is a one-sided hook, so it cannot be misread
 * as a third way to mark.
 */
export const ClearRangeIcon = glyph(
  <>
    <path d={bracketPath("left", CLEAR_LEFT, CLEAR_FOOT)} />
    <path d={bracketPath("right", CLEAR_RIGHT, CLEAR_FOOT)} />
    <path d={`m${CROSS.min} ${CROSS.min} ${CROSS_SPAN} ${CROSS_SPAN}`} />
    <path d={`m${CROSS.max} ${CROSS.min} -${CROSS_SPAN} ${CROSS_SPAN}`} />
  </>,
  "ClearRangeIcon",
);
