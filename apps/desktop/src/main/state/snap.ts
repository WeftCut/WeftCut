// The frame-grid snapping the TS actor uses MUST be the shared wasm leaf
// (weftcut-eval `snap_round`) — never a reimplementation — so TS and Rust
// snapping stay byte-identical (feedback_snap_math_drift). Re-exported here so
// main-process code has a stable import that does not reach across into the
// renderer tree at every call site. In tests the wasm is initialized by
// src/renderer/testSetup.ts (initEval in beforeAll); in production the main
// process must await initEval() once at boot before the actor handles a command.
export {
  snapFrameRound,
  snapFrameFloor,
  snapFrameCeil,
  frameIndexRound,
  timeUsAtFrame,
  usToFrame,
  initEval,
} from '../../renderer/eval'

// The grid policy (ADR 0037, 0038) lives beside the leaf wrappers in
// `renderer/grid.ts`, for the same reason the leaf itself does: BOTH sides need it —
// the actor for its enforcement sites, the timeline UI for nudges and readouts —
// and a copy on each side is exactly the drift the single seam prevents.
export {
  AUDIO_GRID,
  AUDIO_SAMPLE_RATE_HZ,
  floorTravelAtZero,
  frameGrid,
  gridIndex,
  isCanonicalOnGrid,
  layerOverlapClass,
  snapDownOnGrid,
  snapOnGrid,
  snapUpOnGrid,
  timeUsAtGridIndex,
  travelBy,
  travelCrossesZero,
  travelOnGrid,
  type Grid,
  type ShiftMember,
  type Travel,
} from '../../renderer/grid'

import { automationGrid as automationGridOfString } from '../../renderer/grid'
import type { Grid as GridT } from '../../renderer/grid'
import type { LayerParams, Rational } from './model'

/** The automation-key lattice, narrowed to the actor's own `LayerParams['kind']`
 *  union so a typo in a mutation is a compile error rather than a silent
 *  frame-grid fallback. */
export function automationGrid(kind: LayerParams['kind'], fps: Rational): GridT {
  return automationGridOfString(kind, fps)
}
