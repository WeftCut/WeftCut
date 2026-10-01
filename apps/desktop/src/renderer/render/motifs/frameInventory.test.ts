import { afterEach, expect, it, vi } from "vitest";
import { MotifFrameCache, hashCacheKey } from "./frameCache";

afterEach(() => vi.unstubAllGlobals());

it("restores only canonical committed frame files with one directory read", async () => {
  const readDir = vi.fn(async () => [
    ...["0.wfrm", "2.wfrm", "1.png", "3.abcd.tmp", "04.wfrm", "-1.wfrm", "1.5.wfrm", "9007199254740992.wfrm"]
      .map(name => ({ name, isFile: true, isDirectory: false, isSymlink: false })),
    { name: "5.wfrm", isFile: false, isDirectory: true, isSymlink: false },
    { name: "6.wfrm", isFile: true, isDirectory: false, isSymlink: true },
  ]);
  vi.stubGlobal("window", { api: {
    backend: { invoke: vi.fn(async () => "/workspace") },
    path: { join: async (parts: string[]) => parts.join("/") },
    fs: { readDir },
  } });
  expect(await new MotifFrameCache().listPersistedFrames("content")).toEqual(new Set([0, 2]));
  expect(readDir).toHaveBeenCalledExactlyOnceWith(`/workspace/Cache/raster/${hashCacheKey("content")}`);
});
