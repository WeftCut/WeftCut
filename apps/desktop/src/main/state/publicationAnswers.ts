import type { ProjectPublication, ProjectPublicationReply } from '../../shared/projectPublication'
import { diffSnapshot } from '../../shared/snapshotPatch'

/** Answers remembered as possible bases. A reply that lands behind the newest
 * event is not applied, so a burst of commits leaves the reader's base a few
 * answers old; a whole projection is the price of falling further behind. The
 * views share their unchanged branches, so holding them costs little. */
const REMEMBERED_ANSWERS = 8
/** Past this a difference is no cheaper to send than the projection. */
const MAX_PATCHES = 2048

/** Answers publication reads with the difference from the view the reader
 * holds, or the whole projection when that is all it can honestly do. The whole
 * projection is always a correct answer, so every doubt resolves to it (ADR 0157).
 *
 * A base names one answer, not a version: a forced refresh answers the same
 * version with newer filesystem fields, and the reader may have dropped that
 * reply, so a version does not say which bytes the reader holds. */
export function createPublicationAnswers<T>() {
  const sent: { viewId: number; view: ProjectPublication<T> }[] = []
  let lastViewId = 0
  return (current: ProjectPublication<T>, base: number | null): ProjectPublicationReply<T> => {
    const viewId = ++lastViewId
    const held = base === null ? undefined : sent.find(answer => answer.viewId === base)?.view
    sent.unshift({ viewId, view: current })
    sent.length = Math.min(sent.length, REMEMBERED_ANSWERS)
    const whole = { ...current, viewId }
    if (base === null || !held || held.summary === null || current.summary === null
      || held.version.session !== current.version.session) return whole
    const patches = diffSnapshot(held.summary, current.summary)
    return patches.length > MAX_PATCHES ? whole : { version: current.version, viewId, base, patches }
  }
}
