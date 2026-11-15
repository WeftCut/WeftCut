// The canvas snapping glyph: the clip snapping magnet beside it, inside two
// frame corners. One metaphor for both snap switches; the corners say where
// this one applies. Not a stock `Scan*` glyph: those read as scanning, and
// `ScanEye` already wears that shape in the same strip.

import type { SVGProps } from "react";

/** Lucide's `Magnet` body, verbatim, so the two snap buttons share one shape. */
const MAGNET_PATHS = [
  "m12 15 4 4",
  "M2.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.029-6.029a1 1 0 1 1 3 3l-6.029 6.029a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l6.365-6.367A1 1 0 0 0 8.716 4.282z",
  "m5 8 4 4",
] as const;

/** The magnet shrunk to sit inside the corners. Its stroke is widened by the
 *  inverse factor so it draws at the same weight as the corners. */
const MAGNET_SCALE = 0.55;
const MAGNET_OFFSET = 5.5;
const STROKE = 2;

type GlyphProps = { size?: number | string } & Omit<
  SVGProps<SVGSVGElement>,
  "size"
>;

/**
 * Two frame corners with the magnet between them. One fixed glyph, like the
 * clip snapping magnet beside it: the strip's pressed styling carries the state.
 */
export const CanvasSnapIcon = ({ size = 24, ...rest }: GlyphProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={STROKE}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...rest}
  >
    <path d="M3 10V5a2 2 0 0 1 2-2h5" />
    <path d="M21 14v5a2 2 0 0 1-2 2h-5" />
    <g
      transform={`translate(${MAGNET_OFFSET} ${MAGNET_OFFSET}) scale(${MAGNET_SCALE})`}
      strokeWidth={STROKE / MAGNET_SCALE}
    >
      {MAGNET_PATHS.map((d) => <path key={d} d={d} />)}
    </g>
  </svg>
);

CanvasSnapIcon.displayName = "CanvasSnapIcon";
