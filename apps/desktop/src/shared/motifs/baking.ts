/** Disk demand is independent of the authored content duration/cache identity. */
export interface MotifFrameRange { start: number; end: number }
export interface MotifBakeContent {
  /** Explicit full preparation survives renderer reload while content remains live. */
  explicit?: boolean;
  cacheKey: string;
  hash: string;
  contentFrames: number;
  ranges: MotifFrameRange[];
  capture: {
    motifId: string;
    contentHash: string;
    propsJson: string;
    width: number;
    height: number;
    settleRafs: number | null;
    fpsNum: number;
    fpsDen: number;
  };
}
export type MotifBakePhase = 'queued' | 'baking' | 'paused' | 'retrying' | 'ready' | 'error';
export type MotifBakePause = 'playback' | 'memory' | 'capacity' | 'disk';
export interface MotifBakeStatus {
  phase: MotifBakePhase;
  done: number;
  total: number;
  reason?: MotifBakePause;
  error?: string;
  lastProgressAt?: number;
}
export interface MotifBakeSnapshot {
  generation: number;
  statuses: Record<string, MotifBakeStatus>;
  /** Exact coverage, including existing frames outside the current demand. */
  coverage: Record<string, number[]>;
}
export interface MotifBakeSession { generation: number; projectId: string | null }
/** Sent after admission reopens, including a failed workspace replacement that
 * restores the same generation. Consumers must redeclare retained demand. */
export const MOTIF_BAKE_READY_EVENT = 'motif:bake-ready';
export interface MotifBakePlan {
  generation: number;
  contents: MotifBakeContent[];
  /** Timeline clip order; repeated content can have different visible ranges. */
  sequence?: { cacheKey: string; ranges: MotifFrameRange[] }[];
  /** One user action: prepend these contents in the supplied order. */
  promoteKeys?: string[];
  /** All referenced content, even with automatic baking disabled. */
  live: { cacheKey: string; hash: string }[];
  collect: boolean;
  /** Only an explicit user action resets exhausted retries. */
  retryKeys?: string[];
}
