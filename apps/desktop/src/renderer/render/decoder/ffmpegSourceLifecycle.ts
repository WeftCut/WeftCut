// Where an `FfmpegSource`'s transport stands, the moves between those stages,
// and what a failed transport leads to. Pure: `FfmpegSource` runs the moves.
// ADR 0162 states the switch contract.
import type { FfmpegLane } from "./decodeEngine";
import type { DecodeTransport } from "./transports/DecodeTransport";
import { isResourceCapacityError } from "../../../shared/resource-policy";
import { HW_BUDGET_EXCEEDED, HW_BUDGET_RESERVATION_MISMATCH } from "../../../shared/ipc";

/** One transport and its open. Callbacks compare against the current attempt
 * by identity, so nothing a replaced transport reports late can land. */
export interface Attempt {
  readonly lane: FfmpegLane;
  readonly transport: DecodeTransport;
  /** The playback divisor it opened at. */
  readonly scaleDiv: number;
  /** Opened with the budget-spill profile. */
  readonly spill: boolean;
  /** The transport reported end of stream. */
  eof: boolean;
  /** An error reported before the open settled: the open failed with it. */
  openError: string | null;
}

/** `releasing`: the previous transport is closing; nothing opens until
 * `closed` settles. `blocked`: refused for capacity, retried after
 * `retryAfterMs`. `failed`: the fatal has been reported. */
export type Slot =
  | { kind: "idle" }
  | { kind: "resolving" }
  | { kind: "opening"; attempt: Attempt }
  | { kind: "ready"; attempt: Attempt }
  | { kind: "releasing"; closed: Promise<void> }
  | { kind: "blocked"; error: unknown; retryAfterMs: number }
  | { kind: "failed"; error: unknown }
  | { kind: "disposed" };

/** Every move a slot makes. Each switch passes through `releasing`, so no
 * open starts while an earlier transport still holds its session. */
export const MOVES: { readonly [K in Slot["kind"]]: readonly Slot["kind"][] } = {
  idle: ["resolving", "disposed"],
  resolving: ["opening", "disposed"],
  opening: ["ready", "releasing", "disposed"],
  ready: ["releasing", "disposed"],
  releasing: ["resolving", "opening", "blocked", "failed", "disposed"],
  blocked: ["resolving", "disposed"],
  failed: ["disposed"],
  disposed: [],
};

/** Any move outside `MOVES` is a bug in `FfmpegSource`, thrown. */
export function checkedMove(from: Slot, to: Slot): Slot {
  if (!MOVES[from.kind].includes(to.kind)) {
    throw new Error(`FfmpegSource transport cannot move from ${from.kind} to ${to.kind}`);
  }
  return to;
}

/** What a transport that failed, at open or later, leads to.
 * `blocked`: global capacity, never a verdict on hardware or quality.
 * `reclaim`: ask the pool to release a retained hardware lease, then retry
 * hardware once. `software`: fall to software keeping the ring; `mark` records
 * a sticky capability failure for the media, `spill` opens the reduced
 * budget-spill profile. `fatal`: the engine cannot decode this source. */
export type FailureVerdict =
  | { kind: "blocked" }
  | { kind: "reclaim" }
  | { kind: "software"; mark: boolean; spill: boolean }
  | { kind: "fatal" };

/** `forced`: a bench pinned the lane, so leaving it would measure the wrong
 * lane. `canReclaim`: the pool can reclaim and this switch has not asked yet. */
export function judgeFailure(f: { lane: FfmpegLane; reason: string; forced: boolean; canReclaim: boolean }): FailureVerdict {
  if (isResourceCapacityError(f.reason)) return { kind: "blocked" };
  if (f.lane === "software" || f.forced) return { kind: "fatal" };
  const budget = f.reason.includes(HW_BUDGET_EXCEEDED);
  if (budget && f.canReclaim) return { kind: "reclaim" };
  // LANDMINE: the budget and a reservation mismatch are transient capacity
  // limits. Marking them pins the media to software for the whole app session
  // after one busy moment, long after the other clips are gone.
  const transient = budget || f.reason.includes(HW_BUDGET_RESERVATION_MISMATCH);
  return { kind: "software", mark: !transient, spill: budget };
}
