import { describe, it, expect, vi } from "vitest";
import { contentTypeFor } from "./builtinAssets";

// The real `electron` package, required without its binary (the unit CI job
// installs none), downloads that binary on the spot.
vi.mock("electron", () => ({ app: { isPackaged: false } }));

describe("contentTypeFor", () => {
  it("maps known extensions and defaults to octet-stream", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("assets/x.woff2")).toBe("font/woff2");
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("weird")).toBe("application/octet-stream");
  });
});
