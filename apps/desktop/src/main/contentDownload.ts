// The app-managed content downloader: stream → verify → install for catalog
// items (src/shared/content-catalog.ts), plus the install-status derivation
// `content:list` reports. Every side effect goes through injected deps (fs,
// http, zip) — no Electron imports and no direct node:fs — so the whole
// lifecycle is unit-testable in-memory (the dataRootMigration.ts discipline).
// The production adapters (Electron net.fetch, node:fs, fflate) are built at
// the call site in src/main/index.ts.
//
// Layout it owns:
//   <downloadsDir>/<id>/<version>/...            installed payload
//   <downloadsDir>/<id>/<version>/manifest.json  written LAST — its presence
//                                                marks a complete install
//   <downloadsDir>/<id>/.staging-<version>/      extraction scratch, renamed
//                                                into place atomically
//   <partialDir>/<id>.part                       in-flight stream target; the
//                                                partial dir lives under
//                                                cache/ (regenerable), so the
//                                                data-root migration never
//                                                copies junk
//   <partialDir>/<id>.part.json                  sidecar naming the artifact
//                                                the .part bytes belong to —
//                                                what makes a partial safe to
//                                                RESUME after a drop, a
//                                                cancel, or an app restart
//
// Resume contract: a transfer never throws away bytes it has already
// received. A network error, a stall, or a cancel leaves the .part + sidecar in
// place; the next attempt asks the server for the tail (`Range`) and re-hashes
// the prefix from disk. Only a failed verification (the bytes are provably
// wrong) or a post-verify install failure discards the partial.

import { createHash } from "node:crypto";
import type {
  ContentArtifact,
  ContentDownloadProgress,
  ContentDownloadResult,
  ContentItem,
  ContentItemStatus,
  ContentPlatformKey,
} from "../shared/content-download";

/** Minimal fs surface — in-memory in tests, node:fs at the call site. */
export interface ContentFs {
  mkdirp(dir: string): void;
  /** Recursive + force — a no-op when the path is missing. */
  rm(path: string): void;
  rename(from: string, to: string): void;
  /** Byte size of a file, or null when it does not exist. */
  statBytes(path: string): number | null;
  /** Names (not paths) of a directory's direct children; [] when missing. */
  listDir(dir: string): string[];
  /** UTF-8 file contents, or null when it does not exist. */
  readText(path: string): string | null;
  writeText(path: string, text: string): void;
  writeBytes(path: string, data: Uint8Array): void;
  /** Stream a file's bytes — the resume path re-hashes the prefix through it. */
  readChunks(path: string): AsyncIterable<Uint8Array>;
  /** `append` continues an existing file; `truncate` (the default) starts over. */
  openWrite(
    path: string,
    mode?: "truncate" | "append",
  ): { write(chunk: Uint8Array): void; close(): void };
}

export interface ContentHttpResponse {
  /** HTTP status: 200 = whole body, 206 = the requested tail, 416 = the
   *  range start is past the end. Anything else is the caller's failure. */
  status: number;
  stream: AsyncIterable<Uint8Array>;
}

/**
 * GET the url; with `rangeStart` set, send `Range: bytes=<rangeStart>-`. Must
 * throw on network failure and must NOT throw on an HTTP status — the resume
 * logic decides what a 200/206/416 means. Must respect the AbortSignal (the
 * production Electron net.fetch adapter does natively).
 */
export interface ContentHttp {
  get(
    url: string,
    signal: AbortSignal,
    opts?: { rangeStart?: number },
  ): Promise<ContentHttpResponse>;
}

export interface ZipEntry {
  /** Entry path as recorded in the archive (zip convention: "/" separators). */
  path: string;
  data: Uint8Array;
}

export interface ContentDeps {
  fs: ContentFs;
  http: ContentHttp;
  /** Read every file entry of a zip on disk (fflate in production). */
  readZipEntries(archivePath: string): Promise<readonly ZipEntry[]>;
  /**
   * Unpack a bzip2- or gzip-compressed tar into a directory (the Rust
   * `content_extract_archive` command in production — ADR 0043/0073). Unlike
   * the zip lane, whose entries flow through this module's guard, tar
   * traversal containment lives in the extractor itself (the `tar` crate
   * refuses entries escaping the dest); the adapter must throw on refusal.
   * It also preserves the entry modes and symlinks the Linux runtimes need
   * to start at all — the zip lane, whose payloads are Windows-only, does not.
   */
  extractTar(archivePath: string, destDir: string): Promise<void>;
  /**
   * Platform finishing step over the staged payload, after it is fully laid
   * out and before it is renamed into place — so a throw here leaves no
   * manifest and the item never reads installed. Present on macOS only, where
   * it ad-hoc re-signs Mach-O files whose upstream signature is invalid
   * (contentSign.ts, ADR 0075); absent everywhere else.
   */
  sealInstall?(stagingDir: string): Promise<void>;
  join(...parts: string[]): string;
  downloadsDir: string;
  partialDir: string;
  /** ISO timestamp for manifest `installedAt` (injected: Date is banned in tests). */
  now(): string;
  /** Silence on the stream before the transfer counts as stalled (default 45 s). */
  stallMs?: number;
  /** Wait between retry attempts (default: real timers; tests inject a no-op). */
  sleep?(ms: number): Promise<void>;
}

/** Digest/size verification failed — retried like a network error, because a
 *  truncated or corrupted transfer is indistinguishable from one. The partial
 *  IS discarded first: its bytes are provably wrong, so resuming them would
 *  fail the same way forever. */
class IntegrityError extends Error {}

/** A zip entry tried to escape the staging dir — never retried: the payload
 *  hash already matched, so re-downloading yields the same hostile archive. */
class ZipSlipError extends Error {}

/** The stream went silent past the stall budget. A transfer failure like any
 *  other (retried, resumed) — its own class only so the message names the cause. */
class StallError extends Error {}

const MAX_ATTEMPTS = 3;
/** Pause before attempt 2 and attempt 3. Short: the common cause is a dropped
 *  connection that is back within seconds, and the retry resumes anyway. */
const RETRY_BACKOFF_MS = [1_000, 4_000] as const;
const DEFAULT_STALL_MS = 45_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function installDir(deps: ContentDeps, item: ContentItem): string {
  return deps.join(deps.downloadsDir, item.id, item.version);
}

function manifestPath(deps: ContentDeps, item: ContentItem): string {
  return deps.join(installDir(deps, item), "manifest.json");
}

function entryAbsPath(
  deps: ContentDeps,
  item: ContentItem,
  artifact: ContentArtifact,
): string {
  return deps.join(installDir(deps, item), ...artifact.entryPath.split("/"));
}

/** The in-flight file and its sidecar for one item. */
export function partialPaths(
  deps: ContentDeps,
  itemId: string,
): { part: string; meta: string } {
  return {
    part: deps.join(deps.partialDir, `${itemId}.part`),
    meta: deps.join(deps.partialDir, `${itemId}.part.json`),
  };
}

/** Drop an item's partial and sidecar (a no-op when there is none). */
export function removePartial(deps: ContentDeps, itemId: string): void {
  const { part, meta } = partialPaths(deps, itemId);
  deps.fs.rm(part);
  deps.fs.rm(meta);
}

/**
 * Fast install-state check: manifest presence + entry-point existence (+ exact
 * byte count for raw payloads, where the pinned size IS the payload size).
 * Zip members have no per-file pin, so their check is existence-only — the
 * full hash ran at install time and the manifest records it ("verify the
 * artifact" happens at download; this is the cheap steady-state read).
 */
export function itemStatus(
  deps: ContentDeps,
  item: ContentItem,
  platform: ContentPlatformKey | null,
): ContentItemStatus {
  const artifact = platform ? item.platforms[platform] : undefined;
  if (!artifact) return { state: "unavailable" };

  const manifestBytes = deps.fs.statBytes(manifestPath(deps, item));
  const entryBytes = deps.fs.statBytes(entryAbsPath(deps, item, artifact));

  if (manifestBytes == null) return { state: "not_installed" };
  const entryOk =
    entryBytes != null &&
    (artifact.archive !== "none" || entryBytes === artifact.bytes);
  if (!entryOk) return { state: "corrupt" };
  return {
    state: "installed",
    entryPath: entryAbsPath(deps, item, artifact),
    installDir: installDir(deps, item),
  };
}

/**
 * Reject archive entries that would write outside the staging dir. Paths are
 * normalized ("\" → "/") before the check so a Windows-authored archive still
 * extracts, while absolute, drive-lettered, or `..`-traversing entries throw.
 * Returns the safe "/"-separated segments.
 */
function guardedEntrySegments(entryPath: string): string[] {
  const normalized = entryPath.replace(/\\/g, "/");
  if (/^([a-zA-Z]:)?\//.test(normalized)) {
    throw new ZipSlipError(`absolute zip entry path: ${entryPath}`);
  }
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) {
    throw new ZipSlipError(`traversal in zip entry path: ${entryPath}`);
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Partial sidecar

/** What a .part's bytes were fetched FOR. Every field must match the current
 *  catalog artifact for the bytes to be resumable — a catalog bump (new
 *  version, new url) makes yesterday's partial junk, not a head start. */
interface PartialMeta {
  url: string;
  sha256: string;
  bytes: number;
  version: string;
}

function partialMetaOf(item: ContentItem, artifact: ContentArtifact): PartialMeta {
  return {
    url: artifact.url,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    version: item.version,
  };
}

function readPartialMeta(deps: ContentDeps, metaPath: string): PartialMeta | null {
  const text = deps.fs.readText(metaPath);
  if (text == null) return null;
  try {
    const raw = JSON.parse(text) as Partial<PartialMeta> | null;
    if (
      raw &&
      typeof raw.url === "string" &&
      typeof raw.sha256 === "string" &&
      typeof raw.bytes === "number" &&
      typeof raw.version === "string"
    ) {
      return { url: raw.url, sha256: raw.sha256, bytes: raw.bytes, version: raw.version };
    }
  } catch {
    /* unreadable sidecar → not resumable */
  }
  return null;
}

function metaMatches(
  meta: PartialMeta,
  item: ContentItem,
  artifact: ContentArtifact,
): boolean {
  return (
    meta.url === artifact.url &&
    meta.sha256 === artifact.sha256 &&
    meta.bytes === artifact.bytes &&
    meta.version === item.version
  );
}

/**
 * How many bytes of an item's partial can be trusted as a resume offset: the
 * on-disk size, but only when a sidecar proves they belong to THIS artifact
 * and the size is plausible (non-empty, not past the pinned total). 0 = start
 * over.
 */
function resumableOffset(
  deps: ContentDeps,
  item: ContentItem,
  artifact: ContentArtifact,
): number {
  const { part, meta } = partialPaths(deps, item.id);
  const recorded = readPartialMeta(deps, meta);
  if (!recorded || !metaMatches(recorded, item, artifact)) return 0;
  const onDisk = deps.fs.statBytes(part) ?? 0;
  return onDisk > 0 && onDisk <= artifact.bytes ? onDisk : 0;
}

/**
 * Download, verify, and atomically install one catalog item. Progress ticks
 * fire per chunk (throttling is the IPC layer's concern). The result union
 * mirrors DataRootMigrateResult: cancellation is a quiet branch, not an error.
 */
export async function downloadItem(
  deps: ContentDeps,
  item: ContentItem,
  platform: ContentPlatformKey | null,
  onProgress: (p: ContentDownloadProgress) => void,
  signal: AbortSignal,
): Promise<ContentDownloadResult> {
  const artifact = platform ? item.platforms[platform] : undefined;
  if (!artifact) {
    return { ok: false, error: `no artifact for this platform: ${item.id}` };
  }

  const { part: partialPath } = partialPaths(deps, item.id);
  const stagingDir = deps.join(
    deps.downloadsDir,
    item.id,
    `.staging-${item.version}`,
  );
  const sleep = deps.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await fetchAndVerify(deps, item, artifact, onProgress, signal);
      // Past this point failures are NOT retried: the bytes on disk already
      // hashed clean, so extraction/install errors are local, not transfer.
      onProgress({
        itemId: item.id,
        phase: "extract",
        receivedBytes: artifact.bytes,
        totalBytes: artifact.bytes,
      });
      const entryPath = await installVerified(deps, item, artifact, partialPath, stagingDir);
      // The .part itself was consumed by the install; its sidecar goes with it.
      removePartial(deps, item.id);
      onProgress({
        itemId: item.id,
        phase: "done",
        receivedBytes: artifact.bytes,
        totalBytes: artifact.bytes,
      });
      return { ok: true, entryPath };
    } catch (e) {
      deps.fs.rm(stagingDir);
      // A cancel keeps the partial: with resume, cancel IS pause.
      if (signal.aborted) return { ok: false, cancelled: true };
      // Bytes that failed verification are wrong, not merely incomplete —
      // resuming them would fail identically; install-stage leftovers have no
      // resume value either. Network drops and stalls keep theirs.
      if (e instanceof IntegrityError || installStageReached(e)) {
        removePartial(deps, item.id);
      }
      const message = e instanceof Error ? e.message : String(e);
      // Transfer-stage failures (network, stall, size, sha) retry; post-verify
      // failures (extraction, install, zip-slip) are local and never do.
      if (attempt < MAX_ATTEMPTS && !installStageReached(e)) {
        await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 0);
        continue;
      }
      onProgress({
        itemId: item.id,
        phase: "error",
        receivedBytes: 0,
        totalBytes: artifact.bytes,
        error: message,
      });
      return { ok: false, error: message };
    }
  }
  // Unreachable: the loop always returns; TypeScript needs the branch.
  return { ok: false, error: "download failed" };
}

/** Marker for errors thrown after verification — see the retry boundary above. */
class InstallStageError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}
function installStageReached(e: unknown): boolean {
  return e instanceof InstallStageError || e instanceof ZipSlipError;
}

/**
 * Wrap a chunk stream so that `stallMs` of silence aborts the underlying
 * fetch and surfaces as a StallError. The race settles on whichever comes
 * first; the loser's eventual rejection is observed by the race itself, so an
 * aborted read never becomes an unhandled rejection.
 */
async function* withStallWatchdog(
  stream: AsyncIterable<Uint8Array>,
  stallMs: number,
  abortFetch: () => void,
): AsyncIterable<Uint8Array> {
  const it = stream[Symbol.asyncIterator]();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abortFetch();
        reject(new StallError(`no data received for ${stallMs} ms`));
      }, stallMs);
    });
    let next: IteratorResult<Uint8Array>;
    try {
      next = await Promise.race([it.next(), stalled]);
    } finally {
      clearTimeout(timer);
    }
    if (next.done) return;
    yield next.value;
  }
}

/**
 * Bring `<id>.part` to the full, verified payload — resuming whatever a
 * previous attempt left when the sidecar vouches for it. Order of operations
 * is deliberate: the Range request goes out BEFORE the prefix is re-hashed, so
 * a server that answers 200 (ignoring the range) costs no wasted disk pass.
 */
async function fetchAndVerify(
  deps: ContentDeps,
  item: ContentItem,
  artifact: ContentArtifact,
  onProgress: (p: ContentDownloadProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const { part: partialPath, meta: metaPath } = partialPaths(deps, item.id);
  const tick = (phase: ContentDownloadProgress["phase"], received: number): void =>
    onProgress({ itemId: item.id, phase, receivedBytes: received, totalBytes: artifact.bytes });

  deps.fs.mkdirp(deps.partialDir);
  let offset = resumableOffset(deps, item, artifact);
  if (offset === 0) {
    // Fresh start: the sidecar is written BEFORE the first byte lands, so a
    // crash at any point leaves a partial the next boot can vouch for.
    deps.fs.rm(partialPath);
    deps.fs.writeText(metaPath, JSON.stringify(partialMetaOf(item, artifact)));
  }

  // The fetch gets its own controller so the stall watchdog can abort it
  // without the USER's signal ever reading as aborted (that branch is
  // "cancelled", this one is "retry").
  const fetchCtl = new AbortController();
  const onUserAbort = (): void => fetchCtl.abort();
  if (signal.aborted) fetchCtl.abort();
  else signal.addEventListener("abort", onUserAbort, { once: true });

  const hash = createHash("sha256");
  let received = 0;
  try {
    let stream: AsyncIterable<Uint8Array> | null = null;
    if (offset < artifact.bytes) {
      let res = await deps.http.get(
        artifact.url,
        fetchCtl.signal,
        offset > 0 ? { rangeStart: offset } : undefined,
      );
      if (offset > 0 && res.status === 200) {
        // The server ignored the Range and is sending the whole file.
        offset = 0;
        deps.fs.rm(partialPath);
      } else if (offset > 0 && res.status === 416) {
        // Our offset is past what the server has: the partial is not what
        // the sidecar claims. Discard it and ask for the whole file.
        offset = 0;
        deps.fs.rm(partialPath);
        res = await deps.http.get(artifact.url, fetchCtl.signal);
      }
      const expected = offset > 0 ? 206 : 200;
      if (res.status !== expected) {
        throw new Error(`HTTP ${res.status} for ${artifact.url}`);
      }
      stream = res.stream;
    }
    // else: every byte already landed (a quit between the last chunk and the
    // verify) — hash what is there and skip the network entirely.

    if (offset > 0) {
      // sha256 state is not serializable, so the prefix is read once more.
      tick("resume", 0);
      for await (const chunk of deps.fs.readChunks(partialPath)) {
        if (signal.aborted) throw new Error("aborted");
        hash.update(chunk);
        received += chunk.byteLength;
        tick("resume", received);
      }
      if (received !== offset) {
        throw new IntegrityError(
          `partial for ${item.id} changed underfoot: expected ${offset} bytes, read ${received}`,
        );
      }
    }

    if (stream) {
      const sink = deps.fs.openWrite(partialPath, offset > 0 ? "append" : "truncate");
      try {
        const guarded = withStallWatchdog(
          stream,
          deps.stallMs ?? DEFAULT_STALL_MS,
          () => fetchCtl.abort(),
        );
        for await (const chunk of guarded) {
          if (signal.aborted) throw new Error("aborted");
          sink.write(chunk);
          hash.update(chunk);
          received += chunk.byteLength;
          tick("download", received);
        }
      } finally {
        sink.close();
      }
    }
  } finally {
    signal.removeEventListener("abort", onUserAbort);
  }

  tick("verify", received);
  if (received !== artifact.bytes) {
    throw new IntegrityError(
      `size mismatch for ${item.id}: expected ${artifact.bytes} bytes, got ${received}`,
    );
  }
  const digest = hash.digest("hex");
  if (digest !== artifact.sha256) {
    throw new IntegrityError(
      `sha256 mismatch for ${item.id}: expected ${artifact.sha256}, got ${digest}`,
    );
  }
}

/**
 * Turn the verified partial into <id>/<version>/: build the full payload in a
 * staging dir, rename it into place, then write manifest.json last. "Atomic"
 * here means crash-shaped, not tick-shaped — a crash at any point leaves
 * either scratch (swept at start) or a manifest-less dir (reported
 * not_installed), never a half-install that claims to be whole.
 */
async function installVerified(
  deps: ContentDeps,
  item: ContentItem,
  artifact: ContentArtifact,
  partialPath: string,
  stagingDir: string,
): Promise<string> {
  const finalDir = installDir(deps, item);
  try {
    deps.fs.rm(stagingDir);
    deps.fs.mkdirp(stagingDir);
    if (artifact.archive === "zip") {
      const entries = await deps.readZipEntries(partialPath);
      for (const entry of entries) {
        // Directory entries carry no payload; their files mkdirp their own
        // parents below.
        if (entry.path.endsWith("/")) continue;
        const segments = guardedEntrySegments(entry.path);
        if (segments.length === 0) continue;
        if (segments.length > 1) {
          deps.fs.mkdirp(deps.join(stagingDir, ...segments.slice(0, -1)));
        }
        deps.fs.writeBytes(deps.join(stagingDir, ...segments), entry.data);
      }
      deps.fs.rm(partialPath);
    } else if (artifact.archive === "tar.bz2" || artifact.archive === "tar.gz") {
      // Traversal containment lives in the extractor (see ContentDeps).
      await deps.extractTar(partialPath, stagingDir);
      deps.fs.rm(partialPath);
    } else {
      deps.fs.rename(
        partialPath,
        deps.join(stagingDir, ...artifact.entryPath.split("/")),
      );
    }
    await deps.sealInstall?.(stagingDir);
    finishInstall(deps, item, artifact, stagingDir, finalDir);
    return entryAbsPath(deps, item, artifact);
  } catch (e) {
    if (e instanceof ZipSlipError) throw e;
    throw new InstallStageError(e);
  }
}

function finishInstall(
  deps: ContentDeps,
  item: ContentItem,
  artifact: ContentArtifact,
  stagingDir: string,
  finalDir: string,
): void {
  deps.fs.rm(finalDir);
  deps.fs.mkdirp(deps.join(deps.downloadsDir, item.id));
  deps.fs.rename(stagingDir, finalDir);
  deps.fs.writeText(
    deps.join(finalDir, "manifest.json"),
    JSON.stringify(
      {
        id: item.id,
        version: item.version,
        url: artifact.url,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        license: item.license,
        installedAt: deps.now(),
      },
      null,
      2,
    ),
  );
}

/**
 * Boot-time sweep of the partial dir. A partial survives only when its
 * sidecar names an artifact the CURRENT catalog still ships for this platform
 * and its size is a plausible resume offset; everything else — orphaned
 * .part files, orphaned sidecars, partials of retired catalog entries — is
 * junk from a previous run and goes. Call once at app start, before any
 * new stream opens.
 */
export function sweepStalePartials(
  deps: ContentDeps,
  items: readonly ContentItem[],
  platform: ContentPlatformKey | null,
): void {
  deps.fs.mkdirp(deps.partialDir);
  const keep = new Set<string>();
  for (const item of items) {
    const artifact = platform ? item.platforms[platform] : undefined;
    if (!artifact) continue;
    if (resumableOffset(deps, item, artifact) > 0) {
      keep.add(`${item.id}.part`);
      keep.add(`${item.id}.part.json`);
    }
  }
  for (const name of deps.fs.listDir(deps.partialDir)) {
    if (!keep.has(name)) deps.fs.rm(deps.join(deps.partialDir, name));
  }
}

/**
 * The speech-config entries that installed managed content should create —
 * the ADR 0039/0043 consumer's decision logic, pure so the only-if-blank rule
 * is testable. Per backend: every `speech`-tagged item must be installed to
 * form an entry (a half pair configures nothing), and an existing entry with
 * ANY non-blank path wins outright — a manual path is never overwritten, and
 * a partially-manual entry is left entirely alone (mixing provenance in one
 * entry is worse than none). Each installed item contributes every field THIS
 * PLATFORM's artifact maps (the Paraformer archive fills model AND tokens),
 * resolved against the item's install dir.
 */
export function speechAutofillPlan(
  items: readonly ContentItem[],
  platform: ContentPlatformKey | null,
  statusOf: (item: ContentItem) => ContentItemStatus,
  existingLocal: Record<string, { binary: string; model: string }>,
  join: (...parts: string[]) => string,
): Array<{ backend: string; config: { binary: string; model: string; tokens?: string } }> {
  const byBackend = new Map<
    string,
    Partial<Record<"binary" | "model" | "tokens", string>> & { complete: boolean }
  >();
  for (const item of items) {
    if (!item.speech) continue;
    const slot = byBackend.get(item.speech.backend) ?? { complete: true };
    const status = statusOf(item);
    if (status.state === "installed") {
      const fields = (platform && item.platforms[platform]?.fields) || {};
      for (const [field, rel] of Object.entries(fields)) {
        slot[field as "binary" | "model" | "tokens"] = join(
          status.installDir,
          ...rel.split("/"),
        );
      }
    } else if (status.state !== "unavailable") {
      // A catalog item this backend needs exists for the platform but is not
      // installed — the set is incomplete, so nothing is configured.
      slot.complete = false;
    }
    byBackend.set(item.speech.backend, slot);
  }

  const plan: Array<{ backend: string; config: { binary: string; model: string; tokens?: string } }> = [];
  for (const [backend, slot] of byBackend) {
    // binary + model are the universal minimum; tokens rides along whenever
    // the catalog provides it (FunASR's availability probe requires it, and
    // its model archive always carries it).
    if (!slot.complete || !slot.binary || !slot.model) continue;
    const existing = existingLocal[backend];
    if (existing && (existing.binary.trim() !== "" || existing.model.trim() !== "")) continue;
    plan.push({
      backend,
      config: {
        binary: slot.binary,
        model: slot.model,
        ...(slot.tokens ? { tokens: slot.tokens } : {}),
      },
    });
  }
  return plan;
}

/**
 * The vlm-config entries installed managed content should create — the ADR 0055
 * twin of {@link speechAutofillPlan}, with the same only-if-blank rule: an
 * existing entry with ANY non-blank path wins outright, so a manual path is
 * never overwritten and a partially-manual entry is left entirely alone.
 *
 * Two differences from the speech plan, both from the shape of the content:
 *  - An item may serve SEVERAL backends (`VlmConsumer.backends`) — one
 *    `llama-mtmd-cli` drives Qwen3-VL and MiniCPM-V alike — so a runtime
 *    contributes its binary to every engine it names.
 *  - The minimum is binary + model + **mmproj**. A GGUF without its vision
 *    projector is text-only and `vlm::config::availability` reports NeedsModel,
 *    so a two-of-three set must configure nothing rather than write an entry
 *    the resolver would refuse.
 *
 * An engine the catalog covers only partly therefore yields no entry: `complete`
 * stays true for it (no item of its own is pending), but a field it never fills
 * keeps the set below the minimum.
 */
export function vlmAutofillPlan(
  items: readonly ContentItem[],
  platform: ContentPlatformKey | null,
  statusOf: (item: ContentItem) => ContentItemStatus,
  existingLocal: Record<string, { binary: string; model: string; mmproj: string }>,
  join: (...parts: string[]) => string,
): Array<{ backend: string; config: { binary: string; model: string; mmproj: string } }> {
  const byBackend = new Map<
    string,
    Partial<Record<"binary" | "model" | "mmproj", string>> & { complete: boolean }
  >();
  for (const item of items) {
    if (!item.vlm) continue;
    const status = statusOf(item);
    for (const backend of item.vlm.backends) {
      const slot = byBackend.get(backend) ?? { complete: true };
      if (status.state === "installed") {
        const fields = (platform && item.platforms[platform]?.fields) || {};
        for (const [field, rel] of Object.entries(fields)) {
          slot[field as "binary" | "model" | "mmproj"] = join(
            status.installDir,
            ...rel.split("/"),
          );
        }
      } else if (status.state !== "unavailable") {
        // A catalog item this backend needs exists for the platform but is not
        // installed — the set is incomplete, so nothing is configured.
        slot.complete = false;
      }
      byBackend.set(backend, slot);
    }
  }

  const plan: Array<{ backend: string; config: { binary: string; model: string; mmproj: string } }> = [];
  for (const [backend, slot] of byBackend) {
    if (!slot.complete || !slot.binary || !slot.model || !slot.mmproj) continue;
    const existing = existingLocal[backend];
    if (
      existing &&
      (existing.binary.trim() !== "" ||
        existing.model.trim() !== "" ||
        existing.mmproj.trim() !== "")
    )
      continue;
    plan.push({
      backend,
      config: { binary: slot.binary, model: slot.model, mmproj: slot.mmproj },
    });
  }
  return plan;
}
