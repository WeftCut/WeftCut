import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ContentArtifact,
  ContentDownloadProgress,
  ContentItem,
} from "../shared/content-download";
import type { ContentDeps, ContentFs, ZipEntry } from "./contentDownload";
import {
  downloadItem,
  itemStatus,
  speechAutofillPlan,
  vlmAutofillPlan,
  sweepStalePartials,
} from "./contentDownload";

// The whole lifecycle runs against an in-memory fs and a scripted http stream
// — no network, no real disk. What these tests pin is the CONTRACT the
// packaged app relies on: a failed transfer retries AND resumes from the bytes
// already on disk, a hostile archive never escapes staging, and an install is
// only "installed" once manifest.json exists (written last).

// ---------------------------------------------------------------------------
// In-memory fs: paths are joined with "/" and stored flat; directories are
// implicit (mkdirp tracked only so rm can be checked against real behavior).

function memFs(): ContentFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const under = (prefix: string) => (p: string) =>
    p === prefix || p.startsWith(prefix + "/");
  return {
    files,
    mkdirp: () => {},
    rm: (path) => {
      for (const key of [...files.keys()]) {
        if (under(path)(key)) files.delete(key);
      }
    },
    rename: (from, to) => {
      const moved: Array<[string, Uint8Array]> = [];
      for (const [key, data] of files) {
        if (under(from)(key)) moved.push([to + key.slice(from.length), data]);
      }
      if (moved.length === 0) throw new Error(`rename: missing ${from}`);
      for (const key of [...files.keys()]) {
        if (under(from)(key)) files.delete(key);
      }
      for (const [key, data] of moved) files.set(key, data);
    },
    statBytes: (path) => {
      const data = files.get(path);
      return data ? data.byteLength : null;
    },
    listDir: (dir) => {
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(dir + "/")) {
          names.add(key.slice(dir.length + 1).split("/")[0] ?? "");
        }
      }
      return [...names];
    },
    readText: (path) => {
      const data = files.get(path);
      return data ? new TextDecoder().decode(data) : null;
    },
    writeText: (path, text) => {
      files.set(path, new TextEncoder().encode(text));
    },
    writeBytes: (path, data) => {
      files.set(path, data);
    },
    readChunks: (path) => streamOf(files.get(path) ?? new Uint8Array()),
    openWrite: (path, mode) => {
      const existing = files.get(path);
      const chunks: Uint8Array[] =
        mode === "append" && existing ? [existing] : [];
      files.set(path, concat(chunks));
      return {
        write: (chunk) => {
          chunks.push(chunk);
          files.set(path, concat(chunks));
        },
        close: () => {},
      };
    },
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function* streamOf(
  data: Uint8Array,
  chunkSize = 4,
): AsyncIterable<Uint8Array> {
  for (let i = 0; i < data.byteLength; i += chunkSize) {
    yield data.slice(i, i + chunkSize);
  }
}

/// Yields `data` in chunks up to `dropAfter` bytes, then fails the way a reset
/// socket does — the shape every resume test starts from.
async function* streamThenThrow(
  data: Uint8Array,
  dropAfter: number,
  chunkSize = 4,
): AsyncIterable<Uint8Array> {
  for (let i = 0; i < data.byteLength; i += chunkSize) {
    if (i >= dropAfter) throw new Error("ECONNRESET mid-stream");
    yield data.slice(i, i + chunkSize);
  }
}

/// Yields `data` up to `hangAfter` bytes, then never resolves again — a TCP
/// connection that silently died. Only the stall watchdog gets out of this.
async function* streamThenHang(
  data: Uint8Array,
  hangAfter: number,
  chunkSize = 4,
): AsyncIterable<Uint8Array> {
  for (let i = 0; i < data.byteLength; i += chunkSize) {
    if (i >= hangAfter) await new Promise<never>(() => {});
    yield data.slice(i, i + chunkSize);
  }
}

/// One scripted server answer. A bare payload is a 200 with that body; an
/// object pins the status (and optionally the body); a function sees the
/// requested range start and answers per call.
type ScriptedAnswer =
  | Uint8Array
  | Error
  | { status: number; stream?: AsyncIterable<Uint8Array> };
type Scripted =
  | ScriptedAnswer
  | ((rangeStart: number | undefined) => ScriptedAnswer);

/// A server that honours Range: the whole body on a plain GET, the tail as a
/// 206 when a start offset is asked for.
function rangeServer(data: Uint8Array): Scripted {
  return (rangeStart) =>
    rangeStart === undefined
      ? data
      : { status: 206, stream: streamOf(data.slice(rangeStart)) };
}

// One deps bundle per test: scripted http (one answer per fetch, in order),
// optional zip entries, optional scripted tar extraction (entries the fake
// extractor "unpacks"). `requests` records the range start of every fetch so a
// test can assert WHERE a retry resumed from.
function makeDeps(opts: {
  fs?: ContentFs;
  responses: Scripted[];
  zipEntries?: readonly ZipEntry[];
  tarEntries?: readonly ZipEntry[] | Error;
  stallMs?: number;
}): ContentDeps & {
  fetches: number;
  requests: Array<number | undefined>;
  extractCalls: string[][];
} {
  const fs = opts.fs ?? memFs();
  const bundle = {
    fetches: 0,
    requests: [] as Array<number | undefined>,
    extractCalls: [] as string[][],
    fs,
    http: {
      get: async (
        _url: string,
        _signal: AbortSignal,
        o?: { rangeStart?: number },
      ) => {
        const scripted = opts.responses[bundle.fetches];
        bundle.fetches += 1;
        bundle.requests.push(o?.rangeStart);
        if (scripted === undefined) throw new Error("no scripted response left");
        const next =
          typeof scripted === "function" ? scripted(o?.rangeStart) : scripted;
        if (next instanceof Error) throw next;
        if (next instanceof Uint8Array) {
          return { status: 200, stream: streamOf(next) };
        }
        return {
          status: next.status,
          stream: next.stream ?? streamOf(new Uint8Array()),
        };
      },
    },
    // Retries never sleep in tests; the stall budget is per-test.
    sleep: async () => {},
    ...(opts.stallMs !== undefined ? { stallMs: opts.stallMs } : {}),
    readZipEntries: async () => opts.zipEntries ?? [],
    extractTar: async (archivePath: string, destDir: string) => {
      bundle.extractCalls.push([archivePath, destDir]);
      if (opts.tarEntries instanceof Error) throw opts.tarEntries;
      for (const entry of opts.tarEntries ?? []) {
        fs.writeBytes(`${destDir}/${entry.path}`, entry.data);
      }
    },
    join: (...parts: string[]) => parts.join("/"),
    downloadsDir: "root/downloads",
    partialDir: "root/cache/content-partial",
    now: () => "2026-08-13T00:00:00.000Z",
  };
  return bundle;
}

const PAYLOAD = new TextEncoder().encode("model-bytes-0123456789");

function rawItem(payload = PAYLOAD): ContentItem {
  return {
    id: "test-model",
    kind: "speech-model",
    version: "rev1",
    labelKey: "x",
    license: { name: "MIT", upstreamUrl: "https://example.com" },
    platforms: {
      "win32-x64": {
        url: "https://example.com/model.bin",
        sha256: sha256(payload),
        bytes: payload.byteLength,
        archive: "none",
        entryPath: "model.bin",
        fields: { model: "model.bin" },
      },
    },
  };
}

function zipItem(archiveBytes: Uint8Array): ContentItem {
  return {
    id: "test-runtime",
    kind: "speech-runtime",
    version: "1.0.0",
    labelKey: "x",
    license: { name: "MIT", upstreamUrl: "https://example.com" },
    platforms: {
      "win32-x64": {
        url: "https://example.com/runtime.zip",
        sha256: sha256(archiveBytes),
        bytes: archiveBytes.byteLength,
        archive: "zip",
        entryPath: "Release/tool.exe",
        fields: { binary: "Release/tool.exe" },
      },
    },
  };
}

/** The same item, with its win32 artifact filling the given config fields. */
function withFields(
  item: ContentItem,
  fields: ContentArtifact["fields"],
): ContentItem {
  return {
    ...item,
    platforms: { "win32-x64": { ...item.platforms["win32-x64"]!, fields } },
  };
}

const noProgress = (): void => {};
const live = () => new AbortController().signal;

describe("downloadItem — raw payload happy path", () => {
  it("installs to <id>/<version>/, writes manifest.json last, reports done", async () => {
    const deps = makeDeps({ responses: [PAYLOAD] });
    const ticks: ContentDownloadProgress[] = [];
    const result = await downloadItem(
      deps,
      rawItem(),
      "win32-x64",
      (p) => ticks.push(p),
      live(),
    );

    expect(result).toEqual({
      ok: true,
      entryPath: "root/downloads/test-model/rev1/model.bin",
    });
    expect(deps.extractCalls).toEqual([]);
    expect(
      deps.fs.statBytes("root/downloads/test-model/rev1/model.bin"),
    ).toBe(PAYLOAD.byteLength);
    const manifest = JSON.parse(
      new TextDecoder().decode(
        (deps.fs as ReturnType<typeof memFs>).files.get(
          "root/downloads/test-model/rev1/manifest.json",
        ),
      ),
    ) as { sha256: string; installedAt: string };
    expect(manifest.sha256).toBe(sha256(PAYLOAD));
    expect(manifest.installedAt).toBe("2026-08-13T00:00:00.000Z");
    // Phases arrive in lifecycle order and finish with done.
    const phases = ticks.map((t) => t.phase);
    expect(phases[0]).toBe("download");
    expect(phases).toContain("verify");
    expect(phases.at(-1)).toBe("done");
    // No partial left behind.
    expect(
      deps.fs.statBytes("root/cache/content-partial/test-model.part"),
    ).toBeNull();
  });
});

describe("downloadItem — transfer-stage failures retry, then fail loud", () => {
  it("sha mismatch: retries to the attempt cap, then reports the digest error", async () => {
    const wrong = new TextEncoder().encode("not-the-model-bytes---");
    expect(wrong.byteLength).toBe(PAYLOAD.byteLength);
    const deps = makeDeps({ responses: [wrong, wrong, wrong] });
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());

    expect(deps.fetches).toBe(3);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : "error" in result ? result.error : "").toContain(
      "sha256 mismatch",
    );
  });

  it("byte-count mismatch fails verification even when the digest would match a truncation", async () => {
    const truncated = PAYLOAD.slice(0, 10);
    const deps = makeDeps({ responses: [truncated, truncated, truncated] });
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : "error" in result ? result.error : "").toContain(
      "size mismatch",
    );
  });

  it("a network throw on attempt 1 succeeds on attempt 2 (the fetch-ffmpeg retry discipline)", async () => {
    const deps = makeDeps({
      responses: [new Error("ECONNRESET mid-stream"), PAYLOAD],
    });
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(true);
    expect(deps.fetches).toBe(2);
  });
});

describe("downloadItem — cancellation is quiet, and it is a pause", () => {
  it("aborting mid-stream returns cancelled (not error), keeps the partial, and the next download resumes from it", async () => {
    const controller = new AbortController();
    const deps = makeDeps({ responses: [PAYLOAD] });
    let aborted = false;
    const result = await downloadItem(
      deps,
      rawItem(),
      "win32-x64",
      (p) => {
        // Abort after the first chunk tick.
        if (p.phase === "download" && !aborted) {
          aborted = true;
          controller.abort();
        }
      },
      controller.signal,
    );
    expect(result).toEqual({ ok: false, cancelled: true });
    // The 4 bytes that landed stay, with the sidecar that vouches for them.
    expect(
      deps.fs.statBytes("root/cache/content-partial/test-model.part"),
    ).toBe(4);
    expect(
      deps.fs.readText("root/cache/content-partial/test-model.part.json"),
    ).toContain(sha256(PAYLOAD));
    expect(
      deps.fs.statBytes("root/downloads/test-model/rev1/manifest.json"),
    ).toBeNull();

    // Second attempt, same disk: one Range request from byte 4, no restart.
    const again = makeDeps({ fs: deps.fs, responses: [rangeServer(PAYLOAD)] });
    const resumed = await downloadItem(again, rawItem(), "win32-x64", noProgress, live());
    expect(resumed.ok).toBe(true);
    expect(again.requests).toEqual([4]);
    expect(
      deps.fs.statBytes("root/downloads/test-model/rev1/model.bin"),
    ).toBe(PAYLOAD.byteLength);
    // Install consumed the partial and its sidecar.
    expect(deps.fs.listDir("root/cache/content-partial")).toEqual([]);
  });
});

describe("downloadItem — resume (a transfer failure never throws bytes away)", () => {
  const partial = "root/cache/content-partial/test-model.part";
  const sidecar = "root/cache/content-partial/test-model.part.json";
  const metaFor = (payload: Uint8Array, version = "rev1") => ({
    url: "https://example.com/model.bin",
    sha256: sha256(payload),
    bytes: payload.byteLength,
    version,
  });
  function seedPartial(
    deps: ContentDeps,
    bytes: Uint8Array,
    meta: ReturnType<typeof metaFor> = metaFor(PAYLOAD),
  ): void {
    deps.fs.writeBytes(partial, bytes);
    deps.fs.writeText(sidecar, JSON.stringify(meta));
  }

  it("a mid-stream drop resumes with a Range request from the on-disk offset and re-hashes the prefix once", async () => {
    const deps = makeDeps({
      responses: [
        { status: 200, stream: streamThenThrow(PAYLOAD, 8) },
        rangeServer(PAYLOAD),
      ],
    });
    const ticks: ContentDownloadProgress[] = [];
    const result = await downloadItem(
      deps,
      rawItem(),
      "win32-x64",
      (p) => ticks.push(p),
      live(),
    );
    expect(result.ok).toBe(true);
    expect(deps.requests).toEqual([undefined, 8]);
    // The resume phase walks exactly the 8 landed bytes, then download ticks
    // continue the count instead of restarting it.
    const phases = ticks.map((t) => t.phase);
    const lastResume = phases.lastIndexOf("resume");
    expect(ticks[lastResume]?.receivedBytes).toBe(8);
    expect(ticks[lastResume + 1]?.phase).toBe("download");
    expect(ticks[lastResume + 1]?.receivedBytes).toBe(12);
    // Verified end to end: the payload installed and the sidecar is gone.
    expect(
      deps.fs.statBytes("root/downloads/test-model/rev1/model.bin"),
    ).toBe(PAYLOAD.byteLength);
    expect(deps.fs.statBytes(sidecar)).toBeNull();
  });

  it("a server that ignores the Range (200) restarts from zero instead of appending", async () => {
    const deps = makeDeps({ responses: [PAYLOAD] });
    seedPartial(deps, PAYLOAD.slice(0, 8));
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(true);
    expect(deps.requests).toEqual([8]);
    expect(
      deps.fs.statBytes("root/downloads/test-model/rev1/model.bin"),
    ).toBe(PAYLOAD.byteLength);
  });

  it("416 (range not satisfiable) discards the partial and fetches the whole file", async () => {
    const deps = makeDeps({ responses: [{ status: 416 }, PAYLOAD] });
    seedPartial(deps, PAYLOAD.slice(0, 8));
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(true);
    expect(deps.requests).toEqual([8, undefined]);
  });

  it("a sidecar naming a different artifact does not vouch for the bytes: fresh start, no Range", async () => {
    const deps = makeDeps({ responses: [rangeServer(PAYLOAD)] });
    seedPartial(
      deps,
      PAYLOAD.slice(0, 8),
      metaFor(new TextEncoder().encode("some-other-artifact")),
    );
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(true);
    expect(deps.requests).toEqual([undefined]);
  });

  it("a complete partial skips the network and goes straight to verify", async () => {
    const deps = makeDeps({ responses: [] });
    seedPartial(deps, PAYLOAD);
    const ticks: ContentDownloadProgress[] = [];
    const result = await downloadItem(
      deps,
      rawItem(),
      "win32-x64",
      (p) => ticks.push(p),
      live(),
    );
    expect(result.ok).toBe(true);
    expect(deps.fetches).toBe(0);
    const phases = ticks.map((t) => t.phase);
    expect(phases[0]).toBe("resume");
    expect(phases).not.toContain("download");
    expect(phases).toContain("verify");
    expect(phases.at(-1)).toBe("done");
  });

  it("a complete but corrupt partial fails verification, is discarded, and the retry fetches whole", async () => {
    const wrong = new TextEncoder().encode("not-the-model-bytes---");
    expect(wrong.byteLength).toBe(PAYLOAD.byteLength);
    const deps = makeDeps({ responses: [rangeServer(PAYLOAD)] });
    seedPartial(deps, wrong);
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(true);
    expect(deps.requests).toEqual([undefined]);
  });

  it("a stalled stream is cut by the watchdog and the retry resumes where it stopped", async () => {
    const deps = makeDeps({
      responses: [
        { status: 200, stream: streamThenHang(PAYLOAD, 8) },
        rangeServer(PAYLOAD),
      ],
      stallMs: 20,
    });
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(true);
    expect(deps.requests).toEqual([undefined, 8]);
  });

  it("a non-2xx answer is a transfer failure: retried to the cap, reported with its status", async () => {
    const deps = makeDeps({
      responses: [{ status: 503 }, { status: 503 }, { status: 503 }],
    });
    const result = await downloadItem(deps, rawItem(), "win32-x64", noProgress, live());
    expect(deps.fetches).toBe(3);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : "error" in result ? result.error : "").toContain(
      "HTTP 503",
    );
  });
});

describe("downloadItem — zip extraction", () => {
  const archive = new TextEncoder().encode("zip-archive-stand-in");

  it("extracts entries into the version dir and resolves the entry path", async () => {
    const deps = makeDeps({
      responses: [archive],
      zipEntries: [
        { path: "Release/", data: new Uint8Array() },
        { path: "Release/tool.exe", data: new TextEncoder().encode("exe") },
        { path: "Release/dep.dll", data: new TextEncoder().encode("dll") },
      ],
    });
    const result = await downloadItem(deps, zipItem(archive), "win32-x64", noProgress, live());
    expect(result).toEqual({
      ok: true,
      entryPath: "root/downloads/test-runtime/1.0.0/Release/tool.exe",
    });
    expect(
      deps.fs.statBytes("root/downloads/test-runtime/1.0.0/Release/dep.dll"),
    ).toBe(3);
  });

  it("a traversal entry aborts the install without retrying (the payload already hashed clean)", async () => {
    const deps = makeDeps({
      responses: [archive, archive, archive],
      zipEntries: [
        { path: "../outside.exe", data: new TextEncoder().encode("bad") },
      ],
    });
    const result = await downloadItem(deps, zipItem(archive), "win32-x64", noProgress, live());
    expect(result.ok).toBe(false);
    expect(deps.fetches).toBe(1);
    // Nothing escaped, nothing installed.
    const files = (deps.fs as ReturnType<typeof memFs>).files;
    expect([...files.keys()].filter((k) => k.includes("outside"))).toEqual([]);
    expect(
      deps.fs.statBytes("root/downloads/test-runtime/1.0.0/manifest.json"),
    ).toBeNull();
  });

  it("an absolute entry path is rejected the same way", async () => {
    const deps = makeDeps({
      responses: [archive],
      zipEntries: [{ path: "C:/evil.exe", data: new Uint8Array([1]) }],
    });
    const result = await downloadItem(deps, zipItem(archive), "win32-x64", noProgress, live());
    expect(result.ok).toBe(false);
    expect(deps.fetches).toBe(1);
  });

  it("backslash-authored entries extract normalized instead of failing", async () => {
    const deps = makeDeps({
      responses: [archive],
      zipEntries: [
        { path: "Release\\tool.exe", data: new TextEncoder().encode("exe") },
      ],
    });
    const result = await downloadItem(deps, zipItem(archive), "win32-x64", noProgress, live());
    expect(result.ok).toBe(true);
    expect(
      deps.fs.statBytes("root/downloads/test-runtime/1.0.0/Release/tool.exe"),
    ).toBe(3);
  });
});

describe("downloadItem — tar extraction (delegated to the injected extractor)", () => {
  const archive = new TextEncoder().encode("tar-bz2-archive-stand-in");

  function tarItem(compression: "tar.bz2" | "tar.gz" = "tar.bz2"): ContentItem {
    return {
      id: "test-tarball",
      kind: "speech-runtime",
      version: "2.0.0",
      labelKey: "x",
      license: { name: "Apache-2.0", upstreamUrl: "https://example.com" },
      platforms: {
        "win32-x64": {
          url: "https://example.com/bundle.tar.bz2",
          sha256: sha256(archive),
          bytes: archive.byteLength,
          archive: compression,
          entryPath: "bundle/bin/tool.exe",
          fields: { binary: "bundle/bin/tool.exe" },
        },
      },
    };
  }

  it("extracts via the adapter into staging and installs atomically", async () => {
    const deps = makeDeps({
      responses: [archive],
      tarEntries: [
        { path: "bundle/bin/tool.exe", data: new TextEncoder().encode("exe") },
        { path: "bundle/tokens.txt", data: new TextEncoder().encode("a b") },
      ],
    });
    const result = await downloadItem(deps, tarItem(), "win32-x64", noProgress, live());
    expect(result).toEqual({
      ok: true,
      entryPath: "root/downloads/test-tarball/2.0.0/bundle/bin/tool.exe",
    });
    // The extractor ran on the verified partial, targeting the staging dir.
    expect(deps.extractCalls).toEqual([
      [
        "root/cache/content-partial/test-tarball.part",
        "root/downloads/test-tarball/.staging-2.0.0",
      ],
    ]);
    expect(
      deps.fs.statBytes("root/downloads/test-tarball/2.0.0/bundle/tokens.txt"),
    ).toBe(3);
    expect(
      deps.fs.statBytes("root/cache/content-partial/test-tarball.part"),
    ).toBeNull();
  });

  it("a gzip tarball takes the same lane — the extractor sniffs, the catalog just says tar", async () => {
    const deps = makeDeps({
      responses: [archive],
      tarEntries: [
        { path: "bundle/bin/tool.exe", data: new TextEncoder().encode("elf") },
      ],
    });
    const result = await downloadItem(
      deps,
      tarItem("tar.gz"),
      "win32-x64",
      noProgress,
      live(),
    );
    expect(result).toEqual({
      ok: true,
      entryPath: "root/downloads/test-tarball/2.0.0/bundle/bin/tool.exe",
    });
    expect(deps.extractCalls).toHaveLength(1);
  });

  it("the seal step runs on the fully staged payload, before the manifest exists", async () => {
    const deps = makeDeps({
      responses: [archive],
      tarEntries: [
        { path: "bundle/bin/tool.exe", data: new TextEncoder().encode("macho") },
      ],
    });
    const sealed: Array<{ dir: string; staged: number | null; manifest: number | null }> = [];
    deps.sealInstall = async (dir) => {
      sealed.push({
        dir,
        staged: deps.fs.statBytes(`${dir}/bundle/bin/tool.exe`),
        manifest: deps.fs.statBytes("root/downloads/test-tarball/2.0.0/manifest.json"),
      });
    };
    const result = await downloadItem(deps, tarItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(true);
    expect(sealed).toEqual([
      { dir: "root/downloads/test-tarball/.staging-2.0.0", staged: 5, manifest: null },
    ]);
  });

  it("a seal failure fails the install without retrying and leaves no manifest", async () => {
    const deps = makeDeps({
      responses: [archive, archive, archive],
      tarEntries: [
        { path: "bundle/bin/tool.exe", data: new TextEncoder().encode("macho") },
      ],
    });
    deps.sealInstall = async () => {
      throw new Error("codesign exited 1");
    };
    const result = await downloadItem(deps, tarItem(), "win32-x64", noProgress, live());
    expect(result).toEqual({ ok: false, error: "codesign exited 1" });
    expect(deps.fetches).toBe(1);
    expect(
      deps.fs.statBytes("root/downloads/test-tarball/2.0.0/manifest.json"),
    ).toBeNull();
    expect(itemStatus(deps, tarItem(), "win32-x64")).toEqual({ state: "not_installed" });
  });

  it("an extractor refusal (hostile archive) fails without retrying", async () => {
    const deps = makeDeps({
      responses: [archive, archive, archive],
      tarEntries: new Error("archive entry escapes the destination: ../x"),
    });
    const result = await downloadItem(deps, tarItem(), "win32-x64", noProgress, live());
    expect(result.ok).toBe(false);
    expect(deps.fetches).toBe(1);
    expect(
      deps.fs.statBytes("root/downloads/test-tarball/2.0.0/manifest.json"),
    ).toBeNull();
  });
});

describe("itemStatus", () => {
  it("walks the whole ladder: unavailable → not_installed → installed → corrupt", async () => {
    const deps = makeDeps({ responses: [PAYLOAD] });
    const item = rawItem();

    expect(itemStatus(deps, item, null)).toEqual({ state: "unavailable" });
    expect(itemStatus(deps, item, "win32-x64")).toEqual({
      state: "not_installed",
    });

    await downloadItem(deps, item, "win32-x64", noProgress, live());
    expect(itemStatus(deps, item, "win32-x64")).toEqual({
      state: "installed",
      entryPath: "root/downloads/test-model/rev1/model.bin",
      installDir: "root/downloads/test-model/rev1",
    });

    // Payload vanishes but the manifest claim remains → corrupt, not
    // not_installed: the UI must offer a re-download that explains itself.
    deps.fs.rm("root/downloads/test-model/rev1/model.bin");
    expect(itemStatus(deps, item, "win32-x64")).toEqual({ state: "corrupt" });
  });

  it("a raw payload with the wrong size on disk is corrupt (the pinned size IS the payload size)", async () => {
    const deps = makeDeps({ responses: [PAYLOAD] });
    const item = rawItem();
    await downloadItem(deps, item, "win32-x64", noProgress, live());
    deps.fs.writeBytes(
      "root/downloads/test-model/rev1/model.bin",
      new Uint8Array([1, 2, 3]),
    );
    expect(itemStatus(deps, item, "win32-x64")).toEqual({ state: "corrupt" });
  });
});

describe("sweepStalePartials", () => {
  const dir = "root/cache/content-partial";
  const meta = (payload: Uint8Array, version = "rev1") =>
    JSON.stringify({
      url: "https://example.com/model.bin",
      sha256: sha256(payload),
      bytes: payload.byteLength,
      version,
    });

  it("keeps a partial its sidecar vouches for and drops every other leftover", () => {
    const deps = makeDeps({ responses: [] });
    // Resumable: matching sidecar, plausible size.
    deps.fs.writeBytes(`${dir}/test-model.part`, PAYLOAD.slice(0, 8));
    deps.fs.writeText(`${dir}/test-model.part.json`, meta(PAYLOAD));
    // Orphan .part, orphan sidecar, a retired item's pair, and a stranger.
    deps.fs.writeBytes(`${dir}/orphan.part`, new Uint8Array([1]));
    deps.fs.writeText(`${dir}/lonely.part.json`, "{}");
    deps.fs.writeBytes(`${dir}/retired.part`, new Uint8Array([1]));
    deps.fs.writeText(`${dir}/retired.part.json`, meta(PAYLOAD));
    deps.fs.writeBytes(`${dir}/junk.tmp`, new Uint8Array([1]));

    sweepStalePartials(deps, [rawItem()], "win32-x64");
    expect(deps.fs.listDir(dir).sort()).toEqual([
      "test-model.part",
      "test-model.part.json",
    ]);
  });

  it("a sidecar for another catalog version does not vouch: the pair goes", () => {
    const deps = makeDeps({ responses: [] });
    deps.fs.writeBytes(`${dir}/test-model.part`, PAYLOAD.slice(0, 8));
    deps.fs.writeText(`${dir}/test-model.part.json`, meta(PAYLOAD, "rev0"));
    sweepStalePartials(deps, [rawItem()], "win32-x64");
    expect(deps.fs.listDir(dir)).toEqual([]);
  });

  it("a partial past the pinned size is junk, and an empty one has nothing to resume", () => {
    const deps = makeDeps({ responses: [] });
    deps.fs.writeBytes(`${dir}/test-model.part`, concat([PAYLOAD, PAYLOAD]));
    deps.fs.writeText(`${dir}/test-model.part.json`, meta(PAYLOAD));
    sweepStalePartials(deps, [rawItem()], "win32-x64");
    expect(deps.fs.listDir(dir)).toEqual([]);

    deps.fs.writeBytes(`${dir}/test-model.part`, new Uint8Array());
    deps.fs.writeText(`${dir}/test-model.part.json`, meta(PAYLOAD));
    sweepStalePartials(deps, [rawItem()], "win32-x64");
    expect(deps.fs.listDir(dir)).toEqual([]);
  });

  it("on a platform the catalog does not cover, nothing is kept", () => {
    const deps = makeDeps({ responses: [] });
    deps.fs.writeBytes(`${dir}/test-model.part`, PAYLOAD.slice(0, 8));
    deps.fs.writeText(`${dir}/test-model.part.json`, meta(PAYLOAD));
    sweepStalePartials(deps, [rawItem()], null);
    expect(deps.fs.listDir(dir)).toEqual([]);
  });
});

describe("speechAutofillPlan — the only-if-blank / whole-set consumer rules", () => {
  const join = (...parts: string[]) => parts.join("/");
  const runtime: ContentItem = {
    ...withFields(rawItem(), { binary: "bin/cli.exe" }),
    id: "engine",
    kind: "speech-runtime",
    speech: { backend: "whisper_cpp" },
  };
  const model: ContentItem = {
    ...withFields(rawItem(), { model: "m.bin" }),
    id: "model",
    kind: "speech-model",
    speech: { backend: "whisper_cpp" },
  };
  const installed = (dir: string) =>
    ({ state: "installed", entryPath: `${dir}/x`, installDir: dir }) as const;

  it("both installed + blank config → one entry with fields resolved against install dirs", () => {
    const plan = speechAutofillPlan(
      [runtime, model],
      "win32-x64",
      (i) => installed(i.id === "engine" ? "/dl/engine/v1" : "/dl/model/v1"),
      {},
      join,
    );
    expect(plan).toEqual([
      {
        backend: "whisper_cpp",
        config: { binary: "/dl/engine/v1/bin/cli.exe", model: "/dl/model/v1/m.bin" },
      },
    ]);
  });

  it("one archive can fill several fields (the Paraformer model+tokens shape)", () => {
    const funasrRuntime: ContentItem = {
      ...withFields(rawItem(), { binary: "sherpa/bin/sherpa-onnx-offline.exe" }),
      id: "fa-engine",
      speech: { backend: "funasr" },
    };
    const funasrModel: ContentItem = {
      ...withFields(rawItem(), {
        model: "para/model.int8.onnx",
        tokens: "para/tokens.txt",
      }),
      id: "fa-model",
      speech: { backend: "funasr" },
    };
    const plan = speechAutofillPlan(
      [funasrRuntime, funasrModel],
      "win32-x64",
      (i) => installed(i.id === "fa-engine" ? "/dl/fa-e/1" : "/dl/fa-m/1"),
      {},
      join,
    );
    expect(plan).toEqual([
      {
        backend: "funasr",
        config: {
          binary: "/dl/fa-e/1/sherpa/bin/sherpa-onnx-offline.exe",
          model: "/dl/fa-m/1/para/model.int8.onnx",
          tokens: "/dl/fa-m/1/para/tokens.txt",
        },
      },
    ]);
  });

  it("a half set configures nothing (engine installed, model missing)", () => {
    const plan = speechAutofillPlan(
      [runtime, model],
      "win32-x64",
      (i) =>
        i.id === "engine" ? installed("/dl/engine/v1") : { state: "not_installed" },
      {},
      join,
    );
    expect(plan).toEqual([]);
  });

  it("any manual path wins outright — even a partially-filled manual entry", () => {
    const statusOf = (i: ContentItem) =>
      installed(i.id === "engine" ? "/dl/engine/v1" : "/dl/model/v1");
    expect(
      speechAutofillPlan(
        [runtime, model],
        "win32-x64",
        statusOf,
        { whisper_cpp: { binary: "C:/my/whisper.exe", model: "" } },
        join,
      ),
    ).toEqual([]);
    expect(
      speechAutofillPlan(
        [runtime, model],
        "win32-x64",
        statusOf,
        { whisper_cpp: { binary: "", model: "C:/my/model.bin" } },
        join,
      ),
    ).toEqual([]);
  });

  it("an all-blank existing entry counts as blank and is filled", () => {
    const plan = speechAutofillPlan(
      [runtime, model],
      "win32-x64",
      (i) => installed(i.id === "engine" ? "/e" : "/m"),
      { whisper_cpp: { binary: "", model: "  " } },
      join,
    );
    expect(plan).toHaveLength(1);
  });

  it("one item, two platforms: each fills the path ITS artifact carries", () => {
    const dual: ContentItem = {
      ...rawItem(),
      id: "engine",
      kind: "speech-runtime",
      speech: { backend: "whisper_cpp" },
      platforms: {
        "win32-x64": {
          ...rawItem().platforms["win32-x64"]!,
          fields: { binary: "Release/whisper-cli.exe" },
        },
        "linux-x64": {
          ...rawItem().platforms["win32-x64"]!,
          fields: { binary: "whisper-bin-ubuntu-x64/whisper-cli" },
        },
      },
    };
    const dualModel: ContentItem = {
      ...model,
      platforms: {
        ...model.platforms,
        "linux-x64": {
          ...rawItem().platforms["win32-x64"]!,
          fields: { model: "m.bin" },
        },
      },
    };
    const plan = speechAutofillPlan(
      [dual, dualModel],
      "linux-x64",
      (i) => installed(i.id === "engine" ? "/e" : "/m"),
      {},
      join,
    );
    expect(plan).toEqual([
      {
        backend: "whisper_cpp",
        config: { binary: "/e/whisper-bin-ubuntu-x64/whisper-cli", model: "/m/m.bin" },
      },
    ]);
  });

  it("platform-unavailable items don't block the set (they're not part of it here)", () => {
    const other: ContentItem = {
      ...withFields(rawItem(), { tokens: "t.txt" }),
      id: "other-os-tokens",
      speech: { backend: "whisper_cpp" },
    };
    const plan = speechAutofillPlan(
      [runtime, model, other],
      "win32-x64",
      (i) =>
        i.id === "other-os-tokens"
          ? { state: "unavailable" }
          : installed(i.id === "engine" ? "/e" : "/m"),
      {},
      join,
    );
    expect(plan).toEqual([
      { backend: "whisper_cpp", config: { binary: "/e/bin/cli.exe", model: "/m/m.bin" } },
    ]);
  });
});

describe("vlmAutofillPlan — same rules, plus mmproj and multi-backend items", () => {
  const join = (...parts: string[]) => parts.join("/");
  const runtime: ContentItem = {
    ...withFields(rawItem(), { binary: "llama-mtmd-cli.exe" }),
    id: "engine",
    kind: "vlm-runtime",
    vlm: { backends: ["qwen3_vl"] },
  };
  const model: ContentItem = {
    ...withFields(rawItem(), { model: "q.gguf" }),
    id: "model",
    kind: "vlm-model",
    vlm: { backends: ["qwen3_vl"] },
  };
  const mmproj: ContentItem = {
    ...withFields(rawItem(), { mmproj: "mm.gguf" }),
    id: "mmproj",
    kind: "vlm-model",
    vlm: { backends: ["qwen3_vl"] },
  };
  const installed = (dir: string) =>
    ({ state: "installed", entryPath: `${dir}/x`, installDir: dir }) as const;
  const allInstalled = (i: ContentItem) => installed(`/dl/${i.id}/v1`);

  it("all three installed + blank config → one entry with paths under their install dirs", () => {
    expect(vlmAutofillPlan([runtime, model, mmproj], "win32-x64", allInstalled, {}, join)).toEqual([
      {
        backend: "qwen3_vl",
        config: {
          binary: "/dl/engine/v1/llama-mtmd-cli.exe",
          model: "/dl/model/v1/q.gguf",
          mmproj: "/dl/mmproj/v1/mm.gguf",
        },
      },
    ]);
  });

  it("a model without its projector configures NOTHING — vision needs all three", () => {
    // The distinguishing rule against speech: binary+model is a complete set
    // there, and only two thirds of one here.
    const plan = vlmAutofillPlan(
      [runtime, model, mmproj],
      "win32-x64",
      (i) => (i.id === "mmproj" ? { state: "not_installed" } : allInstalled(i)),
      {},
      join,
    );
    expect(plan).toEqual([]);
  });

  it("a shared runtime contributes its binary to every backend it names", () => {
    const shared: ContentItem = {
      ...runtime,
      vlm: { backends: ["qwen3_vl", "minicpm_v"] },
    };
    const miniModel: ContentItem = {
      ...withFields(rawItem(), { model: "mini.gguf" }),
      id: "mini-model",
      vlm: { backends: ["minicpm_v"] },
    };
    const miniMmproj: ContentItem = {
      ...withFields(rawItem(), { mmproj: "mini-mm.gguf" }),
      id: "mini-mmproj",
      vlm: { backends: ["minicpm_v"] },
    };
    const plan = vlmAutofillPlan(
      [shared, model, mmproj, miniModel, miniMmproj],
      "win32-x64",
      allInstalled,
      {},
      join,
    );
    expect(plan).toHaveLength(2);
    expect(plan.map((p) => p.backend).sort()).toEqual(["minicpm_v", "qwen3_vl"]);
    // BOTH engines resolve the same runtime install dir for their binary.
    for (const p of plan)
      expect(p.config.binary).toBe("/dl/engine/v1/llama-mtmd-cli.exe");
  });

  it("a backend the shared runtime names but has no model for yields no entry", () => {
    const shared: ContentItem = {
      ...runtime,
      vlm: { backends: ["qwen3_vl", "minicpm_v"] },
    };
    const plan = vlmAutofillPlan([shared, model, mmproj], "win32-x64", allInstalled, {}, join);
    expect(plan.map((p) => p.backend)).toEqual(["qwen3_vl"]);
  });

  it("any manual path wins outright — mmproj alone is enough to leave the entry alone", () => {
    expect(
      vlmAutofillPlan([runtime, model, mmproj], "win32-x64", allInstalled, {
        qwen3_vl: { binary: "", model: "", mmproj: "C:/my/mm.gguf" },
      }, join),
    ).toEqual([]);
  });

  it("an all-blank existing entry counts as blank and is filled", () => {
    const plan = vlmAutofillPlan([runtime, model, mmproj], "win32-x64", allInstalled, {
      qwen3_vl: { binary: "", model: "  ", mmproj: "" },
    }, join);
    expect(plan).toHaveLength(1);
  });

  it("ignores items with no vlm consumer (the speech catalog rows)", () => {
    const speechOnly: ContentItem = {
      ...withFields(rawItem(), { binary: "cli.exe" }),
      id: "whisper",
      speech: { backend: "whisper_cpp" },
    };
    const plan = vlmAutofillPlan(
      [speechOnly, runtime, model, mmproj],
      "win32-x64",
      allInstalled,
      {},
      join,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].backend).toBe("qwen3_vl");
  });
});
