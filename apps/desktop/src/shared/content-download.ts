// Wire types for the app-managed content download surface (`content:*` IPC),
// shared by the Electron main process (owner of the downloader,
// src/main/contentDownload.ts) and the renderer (Settings UI). One definition →
// no main↔renderer drift — the same single-sourcing rule as
// src/shared/data-root.ts. Pure types + consts, no DOM / Node dependency.
//
// The catalog VALUES live in src/shared/content-catalog.ts; this file is the
// action/status contract layered on top of them.

/// `${process.platform}-${process.arch}` keys the catalog's per-platform
/// artifacts. Only platforms with shipped content appear; a platform absent
/// from an item's map reports the item `unavailable` there.
export type ContentPlatformKey =
  | "win32-x64"
  | "darwin-x64"
  | "darwin-arm64"
  | "linux-x64";

/// One downloadable payload for one platform. Supply-chain rule
/// (docs/licensing.md): the URL is versioned and immutable — never a rolling
/// "latest" — and sha256 + exact byte count are pinned so the artifact, not
/// the claim, is what gets verified. (The one URL exception on record: the
/// Paraformer model hangs off a rolling release tag — ADR 0043 — where the
/// pinned sha256 is what carries the trust.)
export interface ContentArtifact {
  url: string;
  sha256: string;
  /// Exact size of the archive (or raw payload) in bytes. Doubles as the
  /// progress denominator and as a cheap integrity floor for status checks.
  bytes: number;
  archive: "zip" | "tar.bz2" | "tar.gz" | "none";
  /// Path of the item's entry point relative to its install dir once
  /// installed — e.g. "Release/whisper-cli.exe" inside the extracted zip, or
  /// the payload file's own name for `archive: "none"`.
  entryPath: string;
  /// Which local-engine config field(s) this platform's payload fills, each a
  /// path relative to the item's install dir. A map rather than a single
  /// field because one archive can carry several config inputs (the Paraformer
  /// bundle ships model AND tokens — ADR 0043); per-platform rather than
  /// per-item because the layout inside an archive is the platform's own —
  /// `Release/whisper-cli.exe` against `whisper-bin-ubuntu-x64/whisper-cli`.
  /// The item's `entryPath` is always one of these paths (catalog invariant).
  fields: Partial<Record<ContentField, string>>;
  /// i18n key for a note about what this platform needs BEYOND the app's own
  /// requirements — e.g. the Microsoft Visual C++ v14 x64 runtime the official
  /// whisper.cpp Windows build dynamically imports. Absent where the payload
  /// asks for nothing the app does not already guarantee.
  prerequisiteKey?: string;
}

/// The local-engine config fields a catalog artifact can fill:
/// [`LocalEngineConfig`](./speech-config.ts) for speech items,
/// [`VlmLocalEngineConfig`](./vlm-config.ts) for vision ones. One union rather
/// than two because an artifact declares its own layout; which family may name
/// which field is a catalog invariant (content-catalog.test.ts), since only
/// vision needs `mmproj` and only FunASR needs `tokens`.
export type ContentField = "binary" | "model" | "tokens" | "mmproj";

/// Which speech backend consumes an item. The main-process auto-fill consumer
/// keys off this instead of hard-coding item ids; what the item's files fill is
/// its per-platform [`ContentArtifact.fields`].
export interface SpeechConsumer {
  backend: "whisper_cpp" | "funasr";
}

/// The video-understanding twin of `SpeechConsumer` (ADR 0055): which local VLM
/// backends an item serves. A separate interface rather than a widened
/// `SpeechConsumer` because the two write to DIFFERENT config stores
/// (speech_config.json vs vlm_config.json) and have different required fields —
/// vision needs `mmproj`, which speech has no concept of.
///
/// `backends` is a LIST, not a scalar, because one runtime here can serve
/// several engines — `llama-mtmd-cli` drives Qwen3-VL and MiniCPM-V alike. An
/// item lists the engines it is part of a COMPLETE set for, so a shared runtime
/// does not advertise an engine whose model the catalog is still missing.
export interface VlmConsumer {
  backends: ReadonlyArray<"qwen3_vl" | "minicpm_v">;
}

/// One catalog entry. `version` names the install directory
/// (<dataRoot>/downloads/<id>/<version>/) so a future upgrade is a sibling
/// install, never an in-place mutation.
export interface ContentItem {
  id: string;
  kind: "speech-runtime" | "speech-model" | "vlm-runtime" | "vlm-model";
  version: string;
  /// i18n key for the human label (en-US + zh-CN).
  labelKey: string;
  /// License provenance travels with the record (docs/licensing.md).
  license: { name: string; upstreamUrl: string };
  speech?: SpeechConsumer;
  vlm?: VlmConsumer;
  platforms: Partial<Record<ContentPlatformKey, ContentArtifact>>;
}

/// Install-state of one item on this machine, as reported by `content:list`.
/// `queued` and `downloading` come from the main-process download queue (the
/// item is on its way); the rest are read from disk.
export type ContentItemStatus =
  | { state: "not_installed" }
  | { state: "queued" }
  | { state: "downloading"; receivedBytes: number; totalBytes: number }
  /// `entryPath` is the ABSOLUTE path of the installed entry point;
  /// `installDir` the ABSOLUTE install root the artifact's field paths
  /// resolve against.
  | { state: "installed"; entryPath: string; installDir: string }
  /// A manifest exists but the payload is missing or size-mismatched —
  /// surfaced instead of silently re-listing as not_installed so the UI can
  /// offer a re-download that explains itself.
  | { state: "corrupt" }
  /// No artifact for this platform in the catalog.
  | { state: "unavailable" };

/// One progress tick from the downloader while an item is in flight. `resume`
/// is the re-hash of bytes a previous attempt already landed (a resumed
/// transfer reads its prefix once before appending), `verify` the post-stream
/// hash comparison, `extract` the archive-unpacking stage.
export interface ContentDownloadProgress {
  itemId: string;
  phase: "resume" | "download" | "verify" | "extract" | "done" | "error";
  receivedBytes: number;
  totalBytes: number;
  /// Present on phase "error" only.
  error?: string;
}

/// Terminal result of one item's download run. Mirrors DataRootMigrateResult:
/// a user cancellation is its own quiet branch, never an error path.
export type ContentDownloadResult =
  | { ok: true; entryPath: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

/// Where one queued item stands. The in-flight states follow the downloader's
/// phases (`resuming` = re-hashing bytes a previous attempt landed); `queued`
/// waits its turn (downloads run one at a time); `error` lingers so the
/// Settings row can show why, until the item is enqueued again or cancelled.
export type ContentQueueState =
  | "queued"
  | "resuming"
  | "downloading"
  | "verifying"
  | "extracting"
  | "error";

export interface ContentQueueEntry {
  itemId: string;
  state: ContentQueueState;
  receivedBytes: number;
  totalBytes: number;
  /// Present on state "error" only.
  error?: string;
}

/// The whole download queue, in run order. Pushed on `evt:content:queue` on
/// every change and returned by `content:enqueue` / `content:queue`, so a
/// freshly mounted Settings row needs no per-event reconciliation.
export interface ContentQueueSnapshot {
  entries: ContentQueueEntry[];
}

/// Derive this process's platform key. Returns null on platforms the catalog
/// scheme doesn't name (the UI then treats every item as `unavailable`).
export function contentPlatformKey(
  platform: string,
  arch: string,
): ContentPlatformKey | null {
  const key = `${platform}-${arch}`;
  switch (key) {
    case "win32-x64":
    case "darwin-x64":
    case "darwin-arm64":
    case "linux-x64":
      return key;
    default:
      return null;
  }
}
