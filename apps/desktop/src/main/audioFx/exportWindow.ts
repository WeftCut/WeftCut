// The export range, in the one spelling the audio side agrees on. Its own
// module so the two callers — the baker's export gate and the state actor's
// export-channel forward — parse identically without the forward taking on a
// dependency on the baker.
//
// See ADR 0063 and docs/audio.md § Clip effects.

/** A µs range of the root composition, as the export gate and the mix planner
 *  window it. */
export interface FxWindow {
  start_us: number
  end_us: number
}

/** The window an export call carries. Accepts the camelCase the renderer sends
 *  and the snake_case wire alias, the same liberality the widened Rust channels
 *  have. Null — the whole project — unless BOTH bounds are numbers, which is
 *  how Rust already reads a half-specified one. */
export function exportWindowFromArgs(args: Record<string, unknown>): FxWindow | null {
  const start = args['startUs'] ?? args['start_us']
  const end = args['endUs'] ?? args['end_us']
  if (typeof start !== 'number' || typeof end !== 'number') return null
  return { start_us: start, end_us: end }
}
