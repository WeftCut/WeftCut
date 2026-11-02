import { describe, expect, it } from "vitest";

import { stillLabel } from "./stillsSheet";

describe("stillLabel", () => {
  it("is the time, and says so when the frame was drawn with effects skipped", () => {
    expect(stillLabel(1_500_000)).toBe("1.50 s");
    expect(stillLabel(1_500_000, [])).toBe("1.50 s");
    expect(stillLabel(1_500_000, ["effects"])).toBe("1.50 s · effects off");
  });
});
