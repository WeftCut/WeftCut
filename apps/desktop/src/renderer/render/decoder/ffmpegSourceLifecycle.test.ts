import { describe, expect, it } from "vitest";
import { MOVES, checkedMove, judgeFailure, type Slot } from "./ffmpegSourceLifecycle";
import { RESOURCE_CAPACITY_EXCEEDED } from "../../../shared/resource-policy";
import { HW_BUDGET_EXCEEDED, HW_BUDGET_RESERVATION_MISMATCH } from "../../../shared/ipc";

const kinds = Object.keys(MOVES) as Slot["kind"][];
const slot = (kind: Slot["kind"]): Slot => ({ kind } as Slot);

describe("ffmpegSourceLifecycle: moves", () => {
  it("allows exactly the listed moves and throws on every other", () => {
    for (const from of kinds) {
      for (const to of kinds) {
        const allowed = MOVES[from].includes(to);
        if (allowed) expect(checkedMove(slot(from), slot(to))).toEqual(slot(to));
        else expect(() => checkedMove(slot(from), slot(to))).toThrow(`cannot move from ${from} to ${to}`);
      }
    }
  });

  it("opens only from a fresh resolve or after the previous transport has closed", () => {
    const into = kinds.filter((from) => MOVES[from].includes("opening"));
    expect(into.sort()).toEqual(["releasing", "resolving"]);
  });

  it("leaves an open transport only by closing it or disposing the source", () => {
    expect([...MOVES.ready].sort()).toEqual(["disposed", "releasing"]);
  });

  it("can dispose from every stage but disposed, and never leaves disposed", () => {
    for (const from of kinds) expect(MOVES[from].includes("disposed")).toBe(from !== "disposed");
    expect(MOVES.disposed).toEqual([]);
  });

  it("reports a fatal once: failed only disposes", () => {
    expect(MOVES.failed).toEqual(["disposed"]);
    expect(kinds.filter((from) => MOVES[from].includes("failed"))).toEqual(["releasing"]);
  });
});

describe("ffmpegSourceLifecycle: failure verdicts", () => {
  const judge = (reason: string, over: Partial<Parameters<typeof judgeFailure>[0]> = {}) =>
    judgeFailure({ lane: "hardware", reason, forced: false, canReclaim: true, ...over });

  it.each([
    ["hardware", false],
    ["hardware", true],
    ["software", false],
  ] as const)("holds a %s source (forced %s) refused for capacity, whatever else the reason says", (lane, forced) => {
    expect(judge(`${RESOURCE_CAPACITY_EXCEEDED}: ${HW_BUDGET_EXCEEDED}`, { lane, forced })).toEqual({ kind: "blocked" });
  });

  it("asks the pool once for a hardware budget refusal, then spills without marking", () => {
    expect(judge(HW_BUDGET_EXCEEDED)).toEqual({ kind: "reclaim" });
    expect(judge(HW_BUDGET_EXCEEDED, { canReclaim: false })).toEqual({ kind: "software", mark: false, spill: true });
  });

  it("falls to the ordinary software profile without marking for a reservation mismatch", () => {
    expect(judge(`${HW_BUDGET_RESERVATION_MISMATCH}: reserved 3840x2160`)).toEqual({ kind: "software", mark: false, spill: false });
  });

  it("marks the media for a capability failure", () => {
    expect(judge("vaapi init failed")).toEqual({ kind: "software", mark: true, spill: false });
  });

  it("is fatal on software and on a forced lane", () => {
    expect(judge("decode error", { lane: "software" })).toEqual({ kind: "fatal" });
    expect(judge(HW_BUDGET_EXCEEDED, { forced: true })).toEqual({ kind: "fatal" });
  });
});
