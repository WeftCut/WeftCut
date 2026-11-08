import { MotifError, motifErrorCode } from '../../shared/motifs/errors.js'

/// Drafts churn lane keys on every edit, so both sets are bounded FIFO.
const LANE_CAP = 128

const laneKeyOf = (motifId: string, contentHash: string) => `${motifId}\0${contentHash}`

/** Which lanes (`motifId` + `contentHash`) a capture must not render again
 * because the Motif's own content failed there (docs/motifs.md#capture-host).
 *
 * A failed lane fast-rejects with its recorded `content` error until the key
 * changes: a draft edit changes the content hash, so recovery is automatic, and
 * known-bad content gets no per-sprite retry storm. An empty content hash (MCP
 * callers) is never marked: with no hash there is no recovery signal. */
export class LanePolicy {
  private readonly failed = new Map<string, MotifError>()
  /// Lanes whose last attempt timed out and that hold one more try. A hung
  /// `__motifSetup`/`__motifRender` has two possible authors, the Motif's own
  /// script (an infinite loop) or a host wedged by load, and the deadline
  /// cannot tell them apart. Without probation one slow frame under contention
  /// lost every frame of a user Motif for the session.
  private readonly probation = new Set<string>()

  /** The error a capture of this lane rejects with, if the lane failed. */
  failure(motifId: string, contentHash: string): MotifError | undefined {
    return this.failed.get(laneKeyOf(motifId, contentHash))
  }

  /** The content failed: latches the lane and returns the `content` error its
   * captures now reject with; `error` itself when the lane has no hash. */
  threw(motifId: string, contentHash: string, error: unknown): unknown {
    if (contentHash === '') return error
    const err = motifErrorCode(error) === 'content' ? error as MotifError
      : new MotifError('content', error instanceof MotifError ? error.detail : String((error as Error | undefined)?.message ?? error), { cause: error })
    if (this.failed.size >= LANE_CAP) this.failed.delete(this.failed.keys().next().value!)
    this.failed.set(laneKeyOf(motifId, contentHash), err)
    return err
  }

  /** A setup or render ran past its deadline: the lane's first strike is
   * probation and returns `error`; a second consecutive one latches it. */
  hung(motifId: string, contentHash: string, error: unknown): unknown {
    if (contentHash === '') return error
    const key = laneKeyOf(motifId, contentHash)
    if (this.probation.has(key)) return this.threw(motifId, contentHash, error)
    if (this.probation.size >= LANE_CAP) this.probation.delete(this.probation.values().next().value!)
    this.probation.add(key)
    return error
  }

  /** The page answered a setup and render: the lane's probation ends. */
  rendered(motifId: string, contentHash: string): void {
    this.probation.delete(laneKeyOf(motifId, contentHash))
  }

  /** An explicit retry: revokes only this lane's latched failure. */
  reset(motifId: string, contentHash: string): void {
    this.failed.delete(laneKeyOf(motifId, contentHash))
  }
}
