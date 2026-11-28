// apps/desktop/src/main/companion/panelSync.ts
//
// `side_preview_sync`, the side-panel view's channel to the app: the routes a
// page fetches, as the ops of one tool the host forwards for the view
// (`cli/companion/panel/transportToolcall.js`). Every outcome the view acts on
// is a plain answer, never a tool error, so retrying one is no failed call.
import type { CompanionHub } from './hub.js'

/** What the tool answers, as its structured content. */
export type PanelSyncAnswer = Record<string, unknown>

/** Thrown for arguments that name no op the view sends. */
export class PanelSyncArgError extends Error {}

export async function runPanelSync(hub: Pick<CompanionHub, 'state' | 'poll' | 'control' | 'signal'>, args: Record<string, unknown>): Promise<PanelSyncAnswer> {
  switch (args.op) {
    case 'state':
      return hub.state() as unknown as PanelSyncAnswer
    case 'events': {
      const since = args.since === undefined ? undefined : Number(args.since)
      if (since !== undefined && !(Number.isInteger(since) && since >= 0)) throw new PanelSyncArgError('events: since must be a whole number from 0')
      return await hub.poll(since, typeof args.stream === 'string' ? args.stream : undefined) as unknown as PanelSyncAnswer
    }
    case 'control':
      // The same outcomes `/companion/control` maps to 204, 409 and 400.
      return { outcome: hub.control({ action: args.action, t_us: args.t_us }) }
    case 'signal':
      return await hub.signal(args.offer)
  }
  throw new PanelSyncArgError(`op must be one of state, events, control, signal; got ${JSON.stringify(args.op)}`)
}
