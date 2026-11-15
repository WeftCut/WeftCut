// What the companion page says about itself, as pure decisions. The order is
// the rule: the first state that holds is the one shown, so a page whose link
// was turned off never claims the app is merely closed.

/**
 * @param {{
 *   link: 'connecting' | 'online' | 'offline' | 'revoked',
 *   editorRefused: boolean,
 *   state: { project: unknown, editor: 'ready' | 'opening' } | null,
 * }} input `link` is the transport's latest word; `editorRefused` is a control
 *   the app answered with 409 since the state last said the editor was ready.
 * @returns {'revoked' | 'offline' | 'connecting' | 'opening' | 'no_project' | 'ready'}
 */
export function pageState(input) {
  const { link, editorRefused, state } = input
  if (link === 'revoked') return 'revoked'
  if (link === 'offline') return 'offline'
  if (state === null) return 'connecting'
  if (editorRefused || (state.project !== null && state.editor !== 'ready')) return 'opening'
  if (state.project === null) return 'no_project'
  return 'ready'
}

/**
 * What the picture's stage shows once the page is `ready`, by the same rule as
 * `pageState`: the first that holds.
 * @param {{
 *   exporting: boolean,
 *   wanted: boolean,
 *   supported: boolean,
 *   failed: boolean,
 *   minimized: boolean,
 *   shown: boolean,
 * }} input `wanted`: the user turned the picture on; `supported`: this
 *   browser can show it; `failed`: the app could not encode it since it was
 *   last asked for; `shown`: a frame was drawn since it last started.
 * @returns {'export' | 'off' | 'unsupported' | 'failed' | 'minimized' | 'starting' | 'live'}
 */
export function pictureState(input) {
  if (input.exporting) return 'export'
  if (!input.wanted) return 'off'
  if (!input.supported) return 'unsupported'
  if (input.failed) return 'failed'
  if (input.minimized) return 'minimized'
  if (!input.shown) return 'starting'
  return 'live'
}

/** An export the page shows progress for: one still running. A job waiting
 *  for a retry the user decides on is not. */
export function exportRunning(job) {
  return job != null && !['completed', 'failed', 'cancelled', 'awaiting_retry'].includes(job.state)
}

/** An export the page shows at all: one running, or the last one's outcome
 *  once it completed or failed. A cancelled job is the user's own doing and
 *  says nothing new. */
export function exportShown(job) {
  return exportRunning(job) || job?.state === 'completed' || job?.state === 'failed'
}

/** How many agent calls the page lists. */
export const CALLS_KEPT = 4

/**
 * The page's agent calls, newest first, with `activity` taken in at `at`
 * (ms since the epoch). The app sends only the latest call, so the list is
 * what this page saw since it opened. A call that ends replaces its own
 * running row instead of adding one.
 * @param {Array<{ client: string, tool: string, state: string, at: number }>} calls
 * @param {{ client: string, tool: string, state: string } | null} activity
 * @param {number} at
 */
export function recordCall(calls, activity, at) {
  if (activity === null) return calls
  const head = calls[0]
  const sameRunning = head !== undefined && head.state === 'running' && head.client === activity.client && head.tool === activity.tool
  return [{ client: activity.client, tool: activity.tool, state: activity.state, at }, ...(sameRunning ? calls.slice(1) : calls)].slice(0, CALLS_KEPT)
}
