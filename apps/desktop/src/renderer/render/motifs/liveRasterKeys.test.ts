import { describe, expect, it } from "vitest";
import { getMotif, type Motif } from "./catalog";
import { collectLiveRasterKeys } from "./liveRasterKeys";

function motifLayer(motifId: string, tStart = 0, tEnd = 5_000_000): any {
  return {
    id: `layer-${motifId}-${tStart}`,
    t_start_us: tStart,
    t_end_us: tEnd,
    enabled: true,
    params: { kind: "Motif", motif_id: motifId, src_in_us: 0, props: { seconds: 5 } },
  };
}

function summaryWith(...layers: any[]): any {
  return {
    root_id: "root",
    compositions: {
      root: { id: "root", tracks: [{ id: "t1", enabled: true, layers }] },
    },
  };
}

const countdown = getMotif("countdown")!;

describe("collectLiveRasterKeys", () => {
  it("returns one cacheKey per resolved motif layer, no unresolved", () => {
    const r = collectLiveRasterKeys(summaryWith(motifLayer("countdown")), 30, 1);
    expect(r.unresolved).toEqual([]);
    expect(r.activeKeys.length).toBe(1);
    expect(r.activeKeys[0]).toContain("countdown|");
  });

  it("walks every composition, not just the root", () => {
    const s = summaryWith(motifLayer("countdown"));
    s.compositions.group = { id: "group", tracks: [{ id: "t2", enabled: true, layers: [motifLayer("countdown", 10, 4_000_000)] }] };
    const r = collectLiveRasterKeys(s, 30, 1);
    expect(r.activeKeys.length).toBe(2);
    expect(r.unresolved).toEqual([]);
  });

  it("reports layers whose motif the catalog cannot resolve", () => {
    const r = collectLiveRasterKeys(
      summaryWith(motifLayer("countdown"), motifLayer("ghost-draft", 8_000_000, 10_000_000)),
      30,
      1,
      (id) => (id === "ghost-draft" ? undefined : countdown) as Motif | undefined,
    );
    expect(r.unresolved).toEqual(["ghost-draft"]);
    expect(r.activeKeys.length).toBe(1);
  });

  it("ignores non-motif layers", () => {
    const text: any = {
      id: "text-1",
      t_start_us: 0,
      t_end_us: 1_000_000,
      enabled: true,
      params: { kind: "Text" },
    };
    const r = collectLiveRasterKeys(summaryWith(text), 30, 1);
    expect(r.activeKeys).toEqual([]);
    expect(r.unresolved).toEqual([]);
  });
});
