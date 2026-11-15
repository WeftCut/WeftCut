// Where the user is looking, as the editor reports it to main on request:
// `project://playhead` (`main/mcp/playheadView.ts`) asks, the editor's
// `renderer/state/playheadReport.ts` answers. Nothing travels while no one
// asks.

/** Main → editor: report the view now. */
export const PLAYHEAD_READ_EVENT = 'playhead:read'
/** Editor → main: the answer to one `PLAYHEAD_READ_EVENT`. */
export const PLAYHEAD_REPORT = 'playhead_report'

export interface PlayheadReadMessage { request_id: string }

/** The editor's view. Every time is on `composition_id`'s own clock, the one
 *  its layers' `t_start_us` / `t_end_us` are on. */
export interface EditorPlayheadReport {
  /** The project the editor shows, so main can tell an answer about a project
   *  it has since replaced. */
  root_id: string
  /** The timeline holding the keyboard: the root, or a Group entered from it. */
  composition_id: string
  t_us: number
  /** As the editor's own readout shows it. */
  timecode: string
  playing: boolean
  /** The marked in/out range resolved to `[t_start_us, t_end_us)`, a lone end
   *  running to the film's edge; null when nothing is marked. */
  range: { t_start_us: number; t_end_us: number } | null
  /** The selected layer ids; empty when no layer is selected. */
  selection: string[]
}

/** `PLAYHEAD_REPORT`'s body: the report, or why the editor has none. */
export type PlayheadReportMessage =
  | { request_id: string; report: EditorPlayheadReport }
  | { request_id: string; error: string }
