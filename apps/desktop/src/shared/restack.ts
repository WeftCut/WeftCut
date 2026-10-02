/** Stable z-order references. Track references remain valid through a gap. */
export type RestackAnchor =
  | { kind: 'layer'; id: string }
  | { kind: 'track'; id: string }
