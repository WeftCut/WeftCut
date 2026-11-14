// What the companion page says about itself, as one pure decision. The order
// is the rule: the first state that holds is the one shown, so a page whose
// link was turned off never claims the app is merely closed.

/**
 * @param {{
 *   link: 'connecting' | 'online' | 'offline' | 'revoked',
 *   editorRefused: boolean,
 *   state: { project: unknown, editor: 'ready' | 'opening' } | null,
 * }} input `link` is the transport's latest word; `editorRefused` is a control
 *   the app answered with 409 since the state last said the editor was ready.
 * @param {Record<string, string>} strings
 * @returns {{ state: 'revoked' | 'offline' | 'connecting' | 'opening' | 'no_project' | 'ready', message: string | null }}
 */
export function pageState(input, strings) {
  const { link, editorRefused, state } = input
  if (link === 'revoked') return { state: 'revoked', message: strings.state_revoked }
  if (link === 'offline') return { state: 'offline', message: strings.state_offline }
  if (state === null) return { state: 'connecting', message: null }
  if (editorRefused || (state.project !== null && state.editor !== 'ready')) return { state: 'opening', message: strings.state_opening }
  if (state.project === null) return { state: 'no_project', message: strings.state_no_project }
  return { state: 'ready', message: null }
}

/**
 * What the picture's stage says once the page is `ready`, by the same rule as
 * `pageState`: the first that holds.
 * @param {{
 *   exporting: boolean,
 *   wanted: boolean,
 *   supported: boolean,
 *   minimized: boolean,
 *   shown: boolean,
 * }} input `wanted`: the user turned the picture on; `supported`: this
 *   browser can show it; `shown`: a frame was drawn since it last started.
 * @param {Record<string, string>} strings
 * @returns {{ picture: 'export' | 'off' | 'unsupported' | 'minimized' | 'starting' | 'live', message: string | null }}
 */
export function pictureState(input, strings) {
  if (input.exporting) return { picture: 'export', message: strings.picture_export }
  if (!input.wanted) return { picture: 'off', message: strings.picture_off }
  if (!input.supported) return { picture: 'unsupported', message: strings.picture_unsupported }
  if (input.minimized) return { picture: 'minimized', message: strings.picture_minimized }
  if (!input.shown) return { picture: 'starting', message: strings.picture_starting }
  return { picture: 'live', message: null }
}

/** An export the page shows progress for: one still running. A job waiting
 *  for a retry the user decides on is not. */
export function exportRunning(job) {
  return job != null && !['completed', 'failed', 'cancelled', 'awaiting_retry'].includes(job.state)
}
