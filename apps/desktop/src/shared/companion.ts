// The companion page's wire: what main serves the page on its loopback
// listener (`main/companion/`), and what main and the editor renderer say to
// each other about it (`renderer/companion/companionBridge.ts`). The page
// itself is plain JS (`apps/desktop/cli/companion/`) and reads these shapes as
// JSON. It reads the project and drives the player; nothing here edits.

/** The player as the editor sees it, in ROOT time. */
export interface CompanionTransport {
  t_us: number
  playing: boolean
}

/** One layer as the page's timeline draws it. */
export interface CompanionClip {
  layer_id: string
  kind: string
  label: string
  t_start_us: number
  t_end_us: number
}

export interface CompanionTrack {
  track_id: string
  clips: CompanionClip[]
}

/** The running or last export, as the page's progress bar reads it. */
export interface CompanionExport {
  job_id: string
  state: string
  /** 0..1 */
  progress: number
  filename: string
}

/** The latest agent call, for the page's one line of activity. */
export interface CompanionActivity {
  client: string
  tool: string
  state: string
}

/** `GET /companion/state`. */
export interface CompanionState {
  /** Null while no project is open. */
  project: { name: string } | null
  /** The root composition: the film the playhead moves over. */
  composition: { duration_us: number; width: number; height: number; fps: { num: number; den: number } } | null
  tracks: CompanionTrack[]
  transport: CompanionTransport
  export: CompanionExport | null
  activity: CompanionActivity | null
  /** `ready` once the editor window has attached its bridge; until then the
   *  player cannot be driven. */
  editor: 'ready' | 'opening'
  /** The app's UI language setting (a locale code), null when unset. */
  language: string | null
}

/** Events on `GET /companion/events`. `project` and `editor` say "read the
 *  state again"; the other three carry their new value. */
export type CompanionEventName = 'project' | 'editor' | 'transport' | 'export' | 'activity'

/** Main → renderer: a page asked the player to move. */
export type CompanionControl =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'seek'; t_us: number }

/** Page → main, `POST /companion/control`: a player control, or bring the
 *  editor window forward. */
export type CompanionPageAction = CompanionControl | { action: 'focus' }

/** What main needs from the attached editor. `watch`: some page is open, so
 *  the editor pushes its transport; with none open it pushes nothing. */
export interface CompanionDemand {
  watch: boolean
}

/** Renderer → main channels. Every one carries the bridge's token; main acts
 *  on the attached token only. */
export const COMPANION_ATTACH = 'companion_attach'
export const COMPANION_DETACH = 'companion_detach'
export const COMPANION_TRANSPORT = 'companion_transport'

/** Main → renderer events, each addressed to one bridge token. */
export const COMPANION_DEMAND_EVENT = 'companion:demand'
export const COMPANION_CONTROL_EVENT = 'companion:control'

export interface CompanionAttachReply { demand: CompanionDemand }
export type CompanionDemandMessage = CompanionDemand & { token: string }
export type CompanionControlMessage = CompanionControl & { token: string }
