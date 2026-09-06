import { describe, expect, it } from "vitest";
import type {
  ContentDownloadProgress,
  ContentDownloadResult,
  ContentItem,
  ContentQueueSnapshot,
} from "../shared/content-download";
import { ContentQueue, type ContentQueueItemEvent } from "./contentQueue";

// The queue is exercised against a SCRIPTED download: each run parks until the
// test resolves it, so ordering, cancellation, and error handling are pinned
// without any bytes moving. What matters here is the contract the Settings row
// leans on — one item at a time, installed items skipped, cancel = drop or
// abort, an error never blocks the next item, shutdown leaves the pending
// list for the next boot.

function item(id: string, bytes = 100): ContentItem {
  return {
    id,
    kind: "speech-model",
    version: "v1",
    labelKey: id,
    license: { name: "MIT", upstreamUrl: "https://example.com" },
    platforms: {
      "win32-x64": {
        url: `https://example.com/${id}`,
        sha256: "0".repeat(64),
        bytes,
        archive: "none",
        entryPath: id,
      },
    },
  };
}

const CATALOG = [item("a"), item("b", 200), item("c")];

interface Run {
  onProgress: (p: ContentDownloadProgress) => void;
  signal: AbortSignal;
  resolve: (r: ContentDownloadResult) => void;
  reject: (e: unknown) => void;
}

function harness(opts: { installed?: string[]; tickMs?: number } = {}) {
  const runs = new Map<string, Run>();
  const changes: ContentQueueSnapshot[] = [];
  const events: Array<[string, ContentQueueItemEvent]> = [];
  const installed: string[] = [];
  const pending: string[][] = [];
  let clock = 0;
  const queue = new ContentQueue({
    catalog: CATALOG,
    isInstalled: (i) => (opts.installed ?? []).includes(i.id),
    totalBytesOf: (i) => i.platforms["win32-x64"]?.bytes ?? 0,
    download: (i, onProgress, signal) =>
      new Promise<ContentDownloadResult>((resolve, reject) => {
        runs.set(i.id, { onProgress, signal, resolve, reject });
        // The real downloader reports `cancelled` when its signal fires.
        signal.addEventListener("abort", () =>
          resolve({ ok: false, cancelled: true }),
        );
      }),
    onChange: (s) => changes.push(s),
    onInstalled: (i) => installed.push(i.id),
    onItemEvent: (i, e) => events.push([i.id, e]),
    onPendingChanged: (ids) => pending.push([...ids]),
    now: () => clock,
    ...(opts.tickMs !== undefined ? { tickMs: opts.tickMs } : {}),
  });
  const run = (id: string): Run => {
    const r = runs.get(id);
    if (!r) throw new Error(`no download started for ${id}`);
    return r;
  };
  // Let the download promise's .then(finish) settle.
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  const states = () => queue.snapshot().entries.map((e) => `${e.itemId}:${e.state}`);
  return {
    queue, runs, run, changes, events, installed, pending, settle, states,
    advance: (ms: number) => { clock += ms; },
  };
}

describe("ContentQueue — enqueue", () => {
  it("skips installed items, dedupes, keeps order, and reports the pending set", () => {
    const h = harness({ installed: ["b"] });
    const snap = h.queue.enqueue(["a", "b", "c", "a"]);
    expect(snap.entries.map((e) => e.itemId)).toEqual(["a", "c"]);
    // `a` started at once; `c` waits its turn with the pinned size as its denominator.
    expect(h.states()).toEqual(["a:downloading", "c:queued"]);
    expect(snap.entries[1]?.totalBytes).toBe(100);
    expect(h.pending.at(-1)).toEqual(["a", "c"]);
    expect(h.runs.has("a")).toBe(true);
    expect(h.runs.has("c")).toBe(false);
  });

  it("an unknown id is a caller bug and throws", () => {
    const h = harness();
    expect(() => h.queue.enqueue(["nope"])).toThrow("unknown content id: nope");
  });

  it("enqueueing an already-pending item is a no-op (no duplicate run, no broadcast)", () => {
    const h = harness();
    h.queue.enqueue(["a"]);
    const before = h.changes.length;
    h.queue.enqueue(["a"]);
    expect(h.changes.length).toBe(before);
    expect(h.states()).toEqual(["a:downloading"]);
  });
});

describe("ContentQueue — one at a time", () => {
  it("the next item starts only after the current one finishes, and a success feeds autofill before the broadcast", async () => {
    const h = harness();
    h.queue.enqueue(["a", "b"]);
    expect(h.runs.has("b")).toBe(false);

    h.run("a").resolve({ ok: true, entryPath: "x" });
    await h.settle();
    expect(h.installed).toEqual(["a"]);
    expect(h.states()).toEqual(["b:downloading"]);
    expect(h.runs.has("b")).toBe(true);
    expect(h.events.map(([id, e]) => `${id}:${e.kind}`)).toEqual([
      "a:started",
      "a:ok",
      "b:started",
    ]);
    // The pending set shrank with the install.
    expect(h.pending.at(-1)).toEqual(["b"]);
  });

  it("progress ticks map phases to states; download ticks are throttled, phase changes are not", () => {
    const h = harness({ tickMs: 250 });
    h.queue.enqueue(["a"]);
    const baseline = h.changes.length;
    const tick = (phase: ContentDownloadProgress["phase"], received: number) =>
      h.run("a").onProgress({ itemId: "a", phase, receivedBytes: received, totalBytes: 100 });

    tick("resume", 10);
    expect(h.states()).toEqual(["a:resuming"]);
    expect(h.changes.length).toBe(baseline + 1);

    // Two download ticks inside one throttle window → one broadcast.
    tick("download", 20);
    h.advance(100);
    tick("download", 30);
    expect(h.changes.length).toBe(baseline + 1);
    h.advance(300);
    tick("download", 40);
    expect(h.changes.length).toBe(baseline + 2);
    expect(h.changes.at(-1)?.entries[0]?.receivedBytes).toBe(40);

    tick("verify", 100);
    expect(h.states()).toEqual(["a:verifying"]);
    tick("extract", 100);
    expect(h.states()).toEqual(["a:extracting"]);
    // Every download tick reaches the LogBus hook un-throttled.
    const ratios = h.events
      .filter(([, e]) => e.kind === "progress")
      .map(([, e]) => (e.kind === "progress" ? e.ratio : -1));
    expect(ratios).toEqual([0.2, 0.3, 0.4]);
  });
});

describe("ContentQueue — cancel", () => {
  it("cancelling a queued item drops it without touching the running one", () => {
    const h = harness();
    h.queue.enqueue(["a", "b"]);
    h.queue.cancel("b");
    expect(h.states()).toEqual(["a:downloading"]);
    expect(h.pending.at(-1)).toEqual(["a"]);
    expect(h.run("a").signal.aborted).toBe(false);
  });

  it("cancelling the running item aborts it, drops it on `cancelled`, and starts the next", async () => {
    const h = harness();
    h.queue.enqueue(["a", "b"]);
    h.queue.cancel("a");
    expect(h.run("a").signal.aborted).toBe(true);
    await h.settle();
    expect(h.states()).toEqual(["b:downloading"]);
    expect(h.events.map(([id, e]) => `${id}:${e.kind}`)).toContain("a:cancelled");
    expect(h.installed).toEqual([]);
  });

  it("cancelling an error entry dismisses it", async () => {
    const h = harness();
    h.queue.enqueue(["a"]);
    h.run("a").resolve({ ok: false, error: "HTTP 503" });
    await h.settle();
    expect(h.states()).toEqual(["a:error"]);
    h.queue.cancel("a");
    expect(h.states()).toEqual([]);
  });
});

describe("ContentQueue — errors", () => {
  it("an error lingers as an entry (with its message), is not pending, and does not block the next item", async () => {
    const h = harness();
    h.queue.enqueue(["a", "b"]);
    h.run("a").resolve({ ok: false, error: "HTTP 503 for a" });
    await h.settle();
    expect(h.states()).toEqual(["a:error", "b:downloading"]);
    expect(h.queue.entryOf("a")?.error).toBe("HTTP 503 for a");
    expect(h.queue.isPending("a")).toBe(false);
    expect(h.queue.isPending("b")).toBe(true);
    expect(h.pending.at(-1)).toEqual(["b"]);
  });

  it("re-enqueueing an errored item supersedes the error entry with a fresh queued one", async () => {
    const h = harness();
    h.queue.enqueue(["a"]);
    h.run("a").resolve({ ok: false, error: "boom" });
    await h.settle();
    h.runs.delete("a");
    h.queue.enqueue(["a"]);
    expect(h.states()).toEqual(["a:downloading"]);
    expect(h.queue.entryOf("a")?.error).toBeUndefined();
    expect(h.runs.has("a")).toBe(true);
  });

  it("a download that REJECTS (a bug, not a result) is recorded as an error, never a wedge", async () => {
    const h = harness();
    h.queue.enqueue(["a", "b"]);
    h.run("a").reject(new Error("adapter exploded"));
    await h.settle();
    expect(h.states()).toEqual(["a:error", "b:downloading"]);
    expect(h.queue.entryOf("a")?.error).toBe("adapter exploded");
  });
});

describe("ContentQueue — shutdown", () => {
  it("aborts the in-flight download but leaves the persisted pending list intact for the next boot", async () => {
    const h = harness();
    h.queue.enqueue(["a", "b"]);
    const persistedBefore = h.pending.length;
    h.queue.shutdown();
    expect(h.run("a").signal.aborted).toBe(true);
    await h.settle();
    // No new persistence write, no new broadcast, nothing started.
    expect(h.pending.length).toBe(persistedBefore);
    expect(h.pending.at(-1)).toEqual(["a", "b"]);
    expect(h.runs.has("b")).toBe(false);
  });
});
