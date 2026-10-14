/** Baseline sizes for application-chrome geometry that JS owns, in CSS pixels
 * at the 1080p Standard layout theme. This is the JS counterpart of
 * `styles/layout-theme.css`: every JS dimension that follows the layout theme is
 * declared here and resolved through `layoutTheme.ts` — `uiPixels()` for layout
 * boxes (rounded), `uiScaled()` for SVG geometry (fractional). Per-panel Dock
 * floors stay in `workspace/panelRegistry.ts` and resolve the same way.
 *
 * Outside the theme on purpose: composition and time-axis coordinates, render
 * tiles, wheel deltas and stroke widths. Those stay with their features. */
export const UI_METRICS = {
  dock: {
    /** Quick Actions strip short axis: its Group floor and its pinned thickness.
     * One number on purpose (see `useFixedStripThickness`). CSS reads it as
     * `--layout-strip-thickness`. */
    stripThickness: 44,
    /** Gap between Dock Groups. */
    groupGap: 6,
  },

  /** Scroll-overflow overlay at either end of a strip (`useEdgeOverflow`). */
  edgeOverflowOverlay: 24,

  agent: {
    /** Agent record panel width; drags are remembered in baseline units. */
    recordWidth: { default: 360, min: 280, max: 720 },
    /** Width always left to the preview column beside the record panel. */
    previewMinWidth: 480,
  },

  /** Log console floor; drags are remembered in baseline units. */
  logConsoleMinHeight: 200,

  /** Mixer content width at which Role cards become console strips. */
  mixerConsoleMinWidth: 392,

  timeline: {
    /** Sticky track-header column. */
    headerColumn: 160,
    /** Track row height; per-track drags are persisted in baseline units. */
    trackHeight: { default: 56, min: 24, max: 200 },
    /** Pointer distance from a layer's left/right edge that trims instead of moves.
     * Clamped to a third of the chip so the two edges never overlap. */
    trimEdgeZone: 6,
    /** Layer chip widths below which its label shortens, then disappears. */
    layerLabelMin: 48,
    layerFullLabelMin: 120,
    /** The sticky name chip inside a layer, and its rename field. */
    clipLabel: {
      /** Offset past the sticky header column where the chip pins. */
      headerInset: 4,
      /** The name's line box (`--font-size-micro`) and the least room around it. */
      line: 10,
      slack: 2,
      /** Most vertical padding the chip takes when the slice has room. */
      padding: 4,
      /** Width cap with full affordances, and when compact. */
      maxWidth: 240,
      compactMaxWidth: 120,
      /** Room left at the clip's right edge: the plain gutter, and room for the
       * lock badge (plus the bake dot on a Motif). */
      edgeReserve: 8,
      lockedReserve: 24,
      lockedReserveMotif: 36,
    },
    /** Target spacing between ruler major labels, in normal and frame mode. */
    rulerMajorSpacing: 100,
    rulerMajorSpacingFrameMode: 80,
    keyframe: {
      /** Keyframe sub-lane rows under a track: collapsed, and focused with the
       * curve editor open. */
      sublaneHeight: 24,
      sublaneExpandedHeight: 72,
      /** Curve editor tangent handle dot: visibly smaller than a key, so the
       * key reads first. `.kf-handle`'s transparent stroke widens the grab. */
      tangentHandleRadius: 4,
      /** End key centre to its extrapolation mark, on the in-clip row and the
       * sub-lane: clear of the sub-lane diamond, inside a collapsed row. */
      extrapGlyphGap: 10,
    },
    marker: {
      /** Marker lane under the ruler: an L plus the name beside it. */
      laneHeight: 20,
      /** Stem height carries the anchored/free distinction: an anchored mark runs
       * nearly the row's full height, a free one is a short tick on the same foot. */
      stem: { anchored: 15, free: 8 },
      /** Foot underside, up from the lane's bottom border; every L rests on it. */
      footInset: 2,
      /** A region's capsule: enough to hold the fine-role name inside it. */
      regionHeight: 13,
      /** Line box of a marker name (`--font-size-fine`), for vertical centring. */
      labelLine: 9,
    },
    review: {
      /** Review lane under the marker lane: one row of tack chips, the marker
       * lane's height. Overlapping tacks share one group chip, so no tack
       * set needs a taller row. */
      laneHeight: 20,
      /** A chip holds a fine-role name, like a marker region's capsule. */
      chipHeight: 13,
      /** Least chip width: the kind icon (`--icon-size-fine`) plus its padding,
       * so a point tack is still a target with its kind on it. */
      chipMinWidth: 13,
      /** Least group chip width: the kind icon plus a two-digit count. */
      groupMinWidth: 26,
      /** The cut mark (▼) hanging from a track lane's top edge where material
       * was taken out: small enough to leave a clip's name readable, and the
       * distance under which two on one lane read as one. */
      cutMark: { width: 7, height: 5, merge: 6 },
    },
  },

  /** Preview transform gizmo. Client pixels over the canvas: the affordances
   * stay the same size on a 4K composition and a 480p one, and follow the UI. */
  gizmo: {
    /** Resize handle dot and its invisible grab disc. Kept modest: every pixel
     * the disc claims comes out of the box interior, which is the move handle. */
    handleRadius: 4.5,
    handleHitRadius: 8,
    /** Below this edge length a midpoint handle would sit under its two corners;
     * it hides rather than stacking three targets on one spot. */
    edgeHandleMinLength: 24,
    /** Gap from the box's top edge to the rotation knob, the knob's backing disc,
     * its glyph and its grab disc. */
    rotateGap: 26,
    rotateKnobRadius: 8,
    rotateGlyph: 11,
    rotateHitRadius: 13,
    /** Anchor target: ring, crosshair arms reaching past it, grab disc. */
    anchorRingRadius: 5.5,
    anchorArm: 9,
    anchorHitRadius: 11,
  },
} as const;
