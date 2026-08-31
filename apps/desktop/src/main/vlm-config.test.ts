import { describe, it, expect } from "vitest";
import {
  createVlmConfigStore,
  toVlmBackendSnapshot,
  type VlmConfigFs,
} from "./vlm-config";

const PATH = "/cfg/vlm_config.json";
const DIR = "/cfg";

function memFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const fs: VlmConfigFs = {
    exists: (p) => files.has(p),
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFile: (p, t) => {
      files.set(p, t);
    },
    rename: (a, b) => {
      const v = files.get(a);
      if (v === undefined) throw new Error("ENOENT");
      files.set(b, v);
      files.delete(a);
    },
    mkdirp: () => {},
  };
  return { fs, files };
}
const store = (seed?: Record<string, string>) =>
  createVlmConfigStore({ ...memFs(seed), path: PATH, dir: DIR });

describe("vlm-config store", () => {
  it("defaults to auto with no local engines when no file", () => {
    expect(store().get()).toEqual({ preferred_engine: "auto", local: {} });
  });

  // ADDITIVE-FIELD SAFETY: an OLD config lacking preferred_engine must load as
  // "auto" (never undefined — that would blank a Settings selector).
  it("backfills preferred_engine to auto when the field is missing", () => {
    const s = store({ [PATH]: '{ "local": {} }' });
    expect(s.get().preferred_engine).toBe("auto");
  });

  it("backfills auto for a wrong-typed / unrecognized preferred_engine", () => {
    expect(store({ [PATH]: '{ "preferred_engine": true }' }).get().preferred_engine).toBe("auto");
    expect(store({ [PATH]: '{ "preferred_engine": "bogus" }' }).get().preferred_engine).toBe("auto");
  });

  it("corrupt JSON degrades to defaults", () => {
    expect(store({ [PATH]: "{not json" }).get()).toEqual({ preferred_engine: "auto", local: {} });
  });

  it("preferred_engine round-trips through an independent reader", () => {
    const { fs } = memFs();
    const s = createVlmConfigStore({ fs, path: PATH, dir: DIR });
    expect(s.apply({ preferred_engine: "qwen3_vl" }).preferred_engine).toBe("qwen3_vl");
    expect(createVlmConfigStore({ fs, path: PATH, dir: DIR }).get().preferred_engine).toBe("qwen3_vl");
  });

  it("persists a local engine's binary/model/mmproj and trims paths", () => {
    const { fs } = memFs();
    const s = createVlmConfigStore({ fs, path: PATH, dir: DIR });
    s.apply({
      local: {
        backend: "qwen3_vl",
        config: { binary: "  /b/cli  ", model: " /m/q.gguf ", mmproj: " /m/mm.gguf " },
      },
    });
    const got = createVlmConfigStore({ fs, path: PATH, dir: DIR }).get().local.qwen3_vl;
    expect(got).toEqual({ binary: "/b/cli", model: "/m/q.gguf", mmproj: "/m/mm.gguf" });
  });

  it("drops a local entry whose paths are all blank", () => {
    const s = store({
      [PATH]: '{ "preferred_engine": "auto", "local": { "qwen3_vl": { "binary": "", "model": "", "mmproj": "" } } }',
    });
    expect(s.get().local.qwen3_vl).toBeUndefined();
  });

  it("stores and clears an endpoint", () => {
    const { fs } = memFs();
    const s = createVlmConfigStore({ fs, path: PATH, dir: DIR });
    s.apply({ endpoint: { url: "http://localhost:8080/v1/chat/completions", model: "qwen2-vl" } });
    expect(createVlmConfigStore({ fs, path: PATH, dir: DIR }).get().endpoint).toEqual({
      url: "http://localhost:8080/v1/chat/completions",
      model: "qwen2-vl",
    });
    s.apply({ endpoint: null });
    expect(createVlmConfigStore({ fs, path: PATH, dir: DIR }).get().endpoint).toBeUndefined();
  });

  // A `preferred_engine` of "cloud" is what a config written before the cloud
  // backend was removed holds. It must degrade to "auto", not survive as a tag
  // no resolver knows.
  it("degrades a retired preferred_engine tag to auto", () => {
    const s = store({ [PATH]: '{ "preferred_engine": "cloud", "local": {} }' });
    expect(s.get().preferred_engine).toBe("auto");
  });

  it("never reads a legacy plaintext endpoint api_key back into the config", () => {
    const s = store({
      [PATH]:
        '{ "preferred_engine": "auto", "local": {}, "endpoint": { "url": "http://h/v1", "api_key": "sk-legacy" } }',
    });
    expect(s.get().endpoint).toEqual({ url: "http://h/v1" });
  });
});

describe("takeLegacyEndpointKey", () => {
  it("returns the plaintext key once and scrubs it from disk", () => {
    const { fs, files } = memFs({
      [PATH]:
        '{ "preferred_engine": "auto", "local": {}, "endpoint": { "url": "http://h/v1", "model": "m", "api_key": "  sk-legacy  " } }',
    });
    const s = createVlmConfigStore({ fs, path: PATH, dir: DIR });
    expect(s.takeLegacyEndpointKey()).toBe("sk-legacy");
    // Scrubbed: the field is gone from the file, the rest of the config intact.
    expect(files.get(PATH)).not.toContain("api_key");
    expect(files.get(PATH)).not.toContain("sk-legacy");
    expect(s.get().endpoint).toEqual({ url: "http://h/v1", model: "m" });
    // Idempotent — a second launch finds nothing to move.
    expect(s.takeLegacyEndpointKey()).toBeNull();
  });

  it("is a no-op with no file, no endpoint, or no key field", () => {
    expect(store().takeLegacyEndpointKey()).toBeNull();
    expect(store({ [PATH]: '{ "local": {} }' }).takeLegacyEndpointKey()).toBeNull();
    expect(
      store({ [PATH]: '{ "local": {}, "endpoint": { "url": "http://h/v1" } }' })
        .takeLegacyEndpointKey(),
    ).toBeNull();
    expect(store({ [PATH]: "{not json" }).takeLegacyEndpointKey()).toBeNull();
  });

  it("scrubs a blank leftover key field but reports nothing to move", () => {
    const { fs, files } = memFs({
      [PATH]: '{ "local": {}, "endpoint": { "url": "http://h/v1", "api_key": "   " } }',
    });
    const s = createVlmConfigStore({ fs, path: PATH, dir: DIR });
    expect(s.takeLegacyEndpointKey()).toBeNull();
    expect(files.get(PATH)).not.toContain("api_key");
  });
});

describe("toVlmBackendSnapshot", () => {
  it("maps local + endpoint into the Rust-tagged BackendConfig shapes, key folded into the endpoint entry", () => {
    const snap = toVlmBackendSnapshot(
      {
        preferred_engine: "auto",
        local: { qwen3_vl: { binary: "/b/cli", model: "/m/q.gguf", mmproj: "/m/mm.gguf" } },
        endpoint: { url: "http://h/v1/chat/completions", model: "m" },
      },
      "  sk-endpoint  ",
    );
    expect(snap.qwen3_vl).toEqual({ kind: "local", binary: "/b/cli", model: "/m/q.gguf", mmproj: "/m/mm.gguf" });
    expect(snap.byo_endpoint).toEqual({
      kind: "endpoint",
      url: "http://h/v1/chat/completions",
      api_key: "sk-endpoint",
      model: "m",
    });
    expect(Object.keys(snap)).toHaveLength(2);
  });

  it("omits the endpoint entry when the URL is blank, key or no key", () => {
    const snap = toVlmBackendSnapshot(
      { preferred_engine: "auto", local: {}, endpoint: { url: "   " } },
      "sk-endpoint",
    );
    expect(snap.byo_endpoint).toBeUndefined();
    expect(Object.keys(snap)).toHaveLength(0);
  });

  // A key alone configures nothing — availability is URL-gated, so a stored key
  // with no endpoint must not put an entry in the snapshot at all.
  it("a key with no endpoint configured yields no entry", () => {
    const snap = toVlmBackendSnapshot({ preferred_engine: "auto", local: {} }, "sk-endpoint");
    expect(Object.keys(snap)).toHaveLength(0);
  });

  it("omits api_key when the endpoint has none, so a self-hosted server sends no header", () => {
    const snap = toVlmBackendSnapshot(
      { preferred_engine: "auto", local: {}, endpoint: { url: "http://h/v1" } },
      null,
    );
    expect(snap.byo_endpoint).toEqual({ kind: "endpoint", url: "http://h/v1" });
  });
});
