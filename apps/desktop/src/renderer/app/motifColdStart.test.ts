import { describe, expect, it } from "vitest";

import { motifColdStart, type MotifColdStartSteps } from "./motifColdStart";

function recorder(over: Partial<MotifColdStartSteps> = {}) {
  const calls: string[] = [];
  const steps: MotifColdStartSteps = {
    openFolder: async () => { calls.push("openFolder"); return "/projects/demo"; },
    close: async () => { calls.push("close"); },
    clearFrames: () => { calls.push("clearFrames"); },
    dropCache: async (dir) => { calls.push(`dropCache ${dir}`); return { files: 3, bytes: 30 }; },
    reopen: async (dir) => { calls.push(`reopen ${dir}`); },
    ...over,
  };
  return { calls, steps };
}

describe("motifColdStart", () => {
  it("closes, drops the cache, clears, then reopens the same folder", async () => {
    const { calls, steps } = recorder();

    await expect(motifColdStart(steps)).resolves.toEqual({ files: 3, bytes: 30 });
    expect(calls).toEqual(["openFolder", "close", "dropCache /projects/demo", "clearFrames", "reopen /projects/demo"]);
  });

  it("does nothing with no project open", async () => {
    const { calls, steps } = recorder({ openFolder: async () => null });

    await expect(motifColdStart(steps)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("keeps the cache when the close fails", async () => {
    const { calls, steps } = recorder({ close: async () => { throw new Error("save failed"); } });

    await expect(motifColdStart(steps)).rejects.toThrow("save failed");
    expect(calls).toEqual(["openFolder"]);
  });

  it("reopens the project when main refuses the cache drop", async () => {
    const { calls, steps } = recorder({ dropCache: async () => { throw new Error("refused"); } });

    await expect(motifColdStart(steps)).rejects.toThrow("refused");
    expect(calls.at(-1)).toBe("reopen /projects/demo");
  });
});
