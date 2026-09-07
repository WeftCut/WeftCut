// Export-readiness gate. Decides, for the video sources an export will decode,
// which are ready, which need a proxy that is still encoding (wait), and which
// have failed. Shares its probe memo with the import-time sweep so a capable
// machine probes each source at most once per session. The audio halves — the
// conform tracker and the effect-chain gate — live here too, on the property
// that unites all of it: nothing may render until its inputs exist.
//
// Owns the decisions, not the UI: every panel transition and every translated
// string is the caller's (`app/useExportFlow.ts`).
//
// See docs/data-model.md#mediaitem and docs/render.md#export-source-resolution.

import {
  AUDIO_FX_STATUS_EVENT,
  MEDIA_JOB_EVENTS,
  type AudioFxStatusEvent,
  type EnsureExportAudioFxResult,
  type LayerFxState,
  type MediaJobEvent,
  type MediaSummary,
} from "../ipc";
import { deriveStatus } from "../state/audioFxStore";
import type { WebcodecsDecodeVerdict } from "./decoder/probeSourceDecodable";
import { resolveDecode } from "./decodeRoute";

/// Session probe memo value. "ok" = decoded a key frame this session (cache
/// hit, skip re-probe). "pending" = a probe is in flight (avoid double-probe).
export type ProbeState = "ok" | "pending";

/// Proxy lifecycle state mirrored from `media:job_*` events (App `proxyState`).
export type ProxyJobState = "pending" | "ready" | "failed";

export class ExportCancelled extends Error {
  constructor() {
    super("export cancelled");
    this.name = "ExportCancelled";
  }
}
export class ExportProxyFailed extends Error {
  constructor(public readonly mediaId: string) {
    super(`proxy generation failed for ${mediaId}`);
    this.name = "ExportProxyFailed";
  }
}

/// Video sources whose export path is the ORIGINAL via DirectExport (no full
/// export master — that's the Proxied route). DirectBoth (Bypass) is H.264 and
/// universally decodable, so it is skipped. Used by BOTH the import sweep (whole
/// pool) and the export gate (referenced-scoped via filtering).
export function sourcesNeedingPreflight(
  mediaById: ReadonlyMap<string, MediaSummary>,
): MediaSummary[] {
  return [...mediaById.values()].filter(
    (m) => m.kind === "Video" && resolveDecode(m).route === "direct-export",
  );
}

/// Video sources that would show a BLANK preview right now (no preview path on
/// the route yet, and not bypassed) — candidates for the preview-from-original
/// bridge. A SUPERSET of `sourcesNeedingPreflight`: it also includes
/// full-proxy/10-bit sources, so a decodable Hi10P/HEVC gets a verdict in the
/// shared memo and can bridge while its proxy builds. The import sweep probes
/// these; the export gate keeps using the narrower `sourcesNeedingPreflight`.
export function sourcesNeedingPreviewProbe(
  mediaById: ReadonlyMap<string, MediaSummary>,
): MediaSummary[] {
  return [...mediaById.values()].filter((m) => {
    if (m.kind !== "Video" || !m.available) return false;
    const r = resolveDecode(m);
    return r.route !== "bypass" && r.previewPath == null;
  });
}

export interface PrepareDeps {
  /// Three-valued decodability verdict for an original
  /// (`classifyWebcodecsDecodability`). Only a DEFINITIVE "unsupported" may
  /// route-correct — see the verdict handling in `prepareExportMedia`.
  probe: (assetUrl: string) => Promise<WebcodecsDecodeVerdict>;
  /// Route-correct + enqueue the full proxy (`ensure_full_proxy` backend command).
  ensureFullProxy: (mediaId: string) => Promise<void>;
  /// Session proxy-job state for a media id (App `proxyState`).
  proxyStateOf: (mediaId: string) => ProxyJobState | undefined;
  /// weftcut-media:// URL for a source's ORIGINAL file.
  urlForOriginal: (m: MediaSummary) => string;
  /// Shared session probe memo (App-owned ref).
  memo: Map<string, ProbeState>;
}

export interface PrepareResult {
  /// Referenced sources whose full proxy is in flight — export must wait.
  waiting: string[];
  /// Referenced sources whose proxy generation has failed — export errors.
  failed: string[];
}

/// For each referenced VIDEO source, confirm an export-decode path exists.
/// Mirrors `resolveDecode(m).exportPath`: a non-null export path (Bypass
/// original, or a landed Proxied master) is ready; a DirectExport route is
/// "ready" only if the original actually decodes (probe); otherwise the source
/// is mid-proxy (wait) or failed.
export async function prepareExportMedia(
  referencedMedia: MediaSummary[],
  deps: PrepareDeps,
): Promise<PrepareResult> {
  const waiting: string[] = [];
  const failed: string[] = [];
  // Sequential: keeps the probe from competing with preview/quick-proxy
  // decoders for the WebCodecs buffer pool (see webcodecs-buffer-pool).
  for (const m of referencedMedia) {
    if (m.kind !== "Video") continue;
    const { route, exportPath } = resolveDecode(m);
    // DirectExport must be probed BEFORE the exportPath short-circuit: its
    // exportPath is the ORIGINAL (always non-null), but the original may be
    // undecodable on this machine, so "ready" can't be assumed from the path
    // alone. Bypass/Proxied export paths are trustworthy (universal H.264, or a
    // generated master), so a non-null exportPath there means ready.
    if (route === "direct-export") {
      // DirectExport: resolveDecode's exportPath is the original — confirm it
      // actually decodes before committing.
      if (deps.memo.get(m.id) === "ok") continue; // cached decodable
      if (deps.memo.get(m.id) === "pending") {
        // The import sweep is already probing this source. Opening a SECOND
        // decoder here would collide with that probe AND with the preview
        // decoder on the WebCodecs buffer pool (ADR 0004): all three contend
        // for the ~13 slots, the probe never gets a frame before its deadline,
        // and a decodable source gets a false-negative → needless route-
        // correction → "no export-ready source". Defer to the sweep's verdict
        // instead of re-probing. The route is still direct-export here, so
        // `resolveDecode(m).exportPath` returns the original and `waitForProxies`
        // resolves on its first check; the export's own decoder is the real
        // backstop. If the sweep later route-corrects this source, a subsequent
        // export sees the proxy.
        waiting.push(m.id);
        continue;
      }
      deps.memo.set(m.id, "pending");
      const verdict = await deps.probe(deps.urlForOriginal(m));
      if (verdict === "ok") {
        deps.memo.set(m.id, "ok");
        continue;
      }
      deps.memo.delete(m.id);
      // Route-correct onto the lossy full proxy ONLY on a DEFINITIVE
      // unsupported-codec verdict. "unknown" is a transient failure (probe
      // deadline on a loaded machine, buffer-pool contention) — exporting the
      // original may fail LOUDLY, but silently shipping proxy quality for a
      // decodable source is worse, and the memo stays clear so the next
      // export re-probes.
      if (verdict === "unsupported") {
        await deps.ensureFullProxy(m.id);
        waiting.push(m.id);
      }
      continue;
    }
    if (exportPath != null) continue; // Bypass / landed Proxied master — export path ready
    // Proxied with no master yet ⇒ resolveDecode exportPath null: the source
    // was route-corrected and its proxy is in flight, or failed.
    if (deps.proxyStateOf(m.id) === "failed") failed.push(m.id);
    else waiting.push(m.id);
  }
  return { waiting, failed };
}

export interface WaitDeps {
  /// True once the DURABLE store shows a usable export path for this id
  /// (i.e. `resolveDecode(store.mediaById.get(id)).exportPath != null`). Keying
  /// off the store — not the media:job_complete event — guarantees the store
  /// runExport reads is already fresh when the wait resolves.
  pathReady: (mediaId: string) => boolean;
  /// Subscribe to store changes; returns an unsubscribe fn.
  subscribeStore: (cb: () => void) => () => void;
  /// Subscribe to proxy-job errors by media id; returns an unsubscribe fn.
  onProxyError: (cb: (mediaId: string) => void) => () => void;
  signal: AbortSignal;
}

/// Listener-shaped dependency: subscribe to an event, resolve to an
/// unlisten fn. Matches the `listen` bridge in `@/bridge/events`.
export type ListenLike = <T>(
  event: string,
  cb: (e: { payload: T }) => void,
) => Promise<() => void>;

export interface ConformTracker {
  /// Resolves once both job listeners are registered. Invoke the readiness
  /// command (`ensure_export_audio_conform`) only AFTER this — a fast conform
  /// job completing between enqueue and registration would otherwise be
  /// missed and the wait would hang.
  ready: Promise<void>;
  /// Resolves when every id has landed a `kind=conform` job completion since
  /// the tracker was created; rejects ExportProxyFailed when a still-pending
  /// id's conform job errors, ExportCancelled when the signal aborts. One
  /// wait at a time.
  waitFor(ids: string[], signal: AbortSignal): Promise<void>;
  dispose(): void;
}

/// Tracks conform job completions/errors by media id. The store can't carry
/// this wait: a stale `conform_path` (cache file deleted) is non-null both
/// before AND after the re-conform, so only the job event marks readiness.
export function createConformTracker(listen: ListenLike): ConformTracker {
  const landed = new Set<string>();
  const failed = new Set<string>();
  let notify: (() => void) | null = null;
  const unsubs: Array<() => void> = [];
  let disposed = false;
  const ready = Promise.all([
    listen<MediaJobEvent>(MEDIA_JOB_EVENTS.complete, (e) => {
      if (e.payload.kind !== "conform") return;
      landed.add(e.payload.media_id);
      notify?.();
    }),
    listen<MediaJobEvent>(MEDIA_JOB_EVENTS.error, (e) => {
      if (e.payload.kind !== "conform") return;
      failed.add(e.payload.media_id);
      notify?.();
    }),
  ]).then((us) => {
    if (disposed) for (const u of us) u();
    else unsubs.push(...us);
  });
  return {
    ready,
    waitFor(ids, signal) {
      return new Promise<void>((resolve, reject) => {
        const pending = new Set(ids);
        const settle = (fn: () => void) => {
          notify = null;
          signal.removeEventListener("abort", onAbort);
          fn();
        };
        const onAbort = () => settle(() => reject(new ExportCancelled()));
        const check = () => {
          for (const id of [...pending]) if (landed.has(id)) pending.delete(id);
          if (pending.size === 0) {
            settle(resolve);
            return;
          }
          // landed wins over failed: a retry's success supersedes the error.
          for (const id of pending) {
            if (failed.has(id)) {
              settle(() => reject(new ExportProxyFailed(id)));
              return;
            }
          }
        };
        if (signal.aborted) {
          reject(new ExportCancelled());
          return;
        }
        signal.addEventListener("abort", onAbort);
        notify = check;
        check();
      });
    },
    dispose() {
      disposed = true;
      notify = null;
      for (const u of unsubs) u();
    },
  };
}

/// Resolves when every id has a ready export path in the store; rejects with
/// ExportProxyFailed if a still-pending id's proxy errors, or ExportCancelled
/// if the signal aborts.
export function waitForProxies(ids: string[], deps: WaitDeps): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const pending = new Set(ids);
    let unsubStore = () => {};
    let unsubErr = () => {};
    const cleanup = () => {
      unsubStore();
      unsubErr();
      deps.signal.removeEventListener("abort", onAbort);
    };
    const check = () => {
      for (const id of [...pending]) if (deps.pathReady(id)) pending.delete(id);
      if (pending.size === 0) {
        cleanup();
        resolve();
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new ExportCancelled());
    };
    if (deps.signal.aborted) {
      reject(new ExportCancelled());
      return;
    }
    deps.signal.addEventListener("abort", onAbort);
    unsubErr = deps.onProxyError((id) => {
      if (pending.has(id) && !deps.pathReady(id)) {
        cleanup();
        reject(new ExportProxyFailed(id));
      }
    });
    unsubStore = deps.subscribeStore(check);
    check(); // initial snapshot — a proxy may have finished before we subscribed
  });
}

// ===== Audio effect chains (ADR 0063) ======================================
// The export mixer reads a layer's BAKED conform sibling wherever one is
// desired, so the gate has to wait for those bakes exactly as it waits for
// conforms. It never falls back to the raw conform: playing something other
// than what the user heard is the worst outcome an export can have (spec
// Decision 9), so a failed bake is an export error naming the layer and the
// effect. See docs/audio.md § Clip effects.

export class ExportAudioFxFailed extends Error {
  constructor(
    public readonly layerId: string,
    public readonly effectId: string | null,
    public readonly kind: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ExportAudioFxFailed";
  }
}

export interface AudioFxTracker {
  /// Resolves once the status listener is registered. Call
  /// `ensureExportAudioFx` only AFTER this — a bake completing between the
  /// command and the registration would otherwise be missed and the wait would
  /// hang. Same rule as `ConformTracker.ready`.
  ready: Promise<void>;
  /// The last state pushed for a layer, or undefined if none has arrived.
  stateOf(layerId: string): LayerFxState | undefined;
  /// Subscribe to any state arrival; returns an unsubscribe.
  subscribe(cb: () => void): () => void;
  dispose(): void;
}

/// Accumulates `audio_fx:status` pushes by layer id. Each push carries the
/// layer's FULL state, so the newest one is the whole truth and this needs no
/// merge — and no store read: the durable mirror would serve the same values,
/// but a tracker the caller owns can be created, awaited and disposed around
/// one gate without racing another consumer's project switch.
export function createAudioFxTracker(listen: ListenLike): AudioFxTracker {
  const states = new Map<string, LayerFxState>();
  const subs = new Set<() => void>();
  let unlisten: (() => void) | null = null;
  let disposed = false;
  const ready = listen<AudioFxStatusEvent>(AUDIO_FX_STATUS_EVENT, (e) => {
    states.set(e.payload.layer_id, e.payload.state);
    for (const cb of subs) cb();
  }).then((u) => {
    if (disposed) u();
    else unlisten = u;
  });
  return {
    ready,
    stateOf: (layerId) => states.get(layerId),
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    dispose() {
      disposed = true;
      subs.clear();
      unlisten?.();
    },
  };
}

/// A layer the export no longer has to wait for: the artifact its desired
/// signature names is on disk, or its effective chain went empty mid-wait (an
/// effect disabled or made incomplete) and it plays the raw conform again.
///
/// An UNKNOWN layer is deliberately NOT satisfied even though a missing entry
/// reduces to `none`: `ensureExportAudioFx` named it, so the baker owes a push,
/// and reading "nothing reported yet" as "nothing to do" would let the export
/// run ahead of the bake.
function fxSatisfied(state: LayerFxState | undefined): boolean {
  if (!state) return false;
  const status = deriveStatus(state);
  return status === "ready" || status === "none";
}

export interface AudioFxWaitDeps {
  stateOf: (layerId: string) => LayerFxState | undefined;
  subscribe: (cb: () => void) => () => void;
  signal: AbortSignal;
}

/// Resolves once every layer's desired bake has landed; rejects
/// ExportAudioFxFailed on a still-unsatisfied layer's failure, ExportCancelled
/// when the signal aborts.
export function waitForAudioFx(
  layerIds: string[],
  deps: AudioFxWaitDeps,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const pending = new Set(layerIds);
    let unsub = (): void => {};
    const cleanup = () => {
      unsub();
      deps.signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new ExportCancelled());
    };
    const check = () => {
      // Satisfied wins over failed, per layer: the baker keeps the last error
      // attached until a bake supersedes it, so a layer that has since gone
      // ready still carries the failure that preceded it.
      for (const id of [...pending]) {
        if (fxSatisfied(deps.stateOf(id))) pending.delete(id);
      }
      if (pending.size === 0) {
        cleanup();
        resolve();
        return;
      }
      for (const id of pending) {
        const error = deps.stateOf(id)?.error;
        if (error) {
          cleanup();
          reject(
            new ExportAudioFxFailed(
              id,
              error.effect_id,
              error.kind,
              error.message,
            ),
          );
          return;
        }
      }
    };
    if (deps.signal.aborted) {
      reject(new ExportCancelled());
      return;
    }
    deps.signal.addEventListener("abort", onAbort);
    unsub = deps.subscribe(check);
    check(); // a bake may have landed between the command and this wait
  });
}

export type AudioFxGateOutcome =
  | { kind: "ok" }
  | { kind: "cancelled" }
  | { kind: "error"; detail: string };

export interface AudioFxGateDeps {
  listen: ListenLike;
  /// `ensureExportAudioFx` — flushes the bake debounce and reports what the mix
  /// is waiting on. A null bound means the whole project.
  ensure: (range: {
    startUs: number | null;
    endUs: number | null;
  }) => Promise<EnsureExportAudioFxResult>;
  range: { startUs: number | null; endUs: number | null };
  /// Display name for one layer, and for one effect kind (its catalog i18n
  /// name; a kind the catalog doesn't know is named by its bare `kind`).
  layerName: (layerId: string) => string;
  effectName: (kind: string | null) => string | null;
  /// One failure, already named — the translated sentence the status bar shows.
  /// `effect` is null when the failure belongs to the CHAIN rather than to one
  /// effect (a missing conform, an ffmpeg refusal of the composed graph): the
  /// error says so instead of blaming an arbitrary card.
  failureDetail: (parts: {
    effect: string | null;
    layer: string;
    message: string;
  }) => string;
  /// Show the "preparing" panel for these layers and hand back the signal its
  /// Cancel button aborts.
  onWaiting: (labels: string[]) => AbortSignal;
}

/// The audio-effect half of the export gate, shared by the audio-only and the
/// full-export paths so the two cannot drift. Listener first, then the command,
/// then the wait; every failure, whether the command reported it or the wait
/// raised it, becomes the same named error.
export async function runAudioFxGate(
  deps: AudioFxGateDeps,
): Promise<AudioFxGateOutcome> {
  const detailFor = (f: {
    layer_id: string;
    kind: string | null;
    error: string;
  }): string =>
    deps.failureDetail({
      effect: deps.effectName(f.kind),
      layer: deps.layerName(f.layer_id),
      message: f.error,
    });
  const tracker = createAudioFxTracker(deps.listen);
  try {
    await tracker.ready;
    const result = await deps.ensure(deps.range);
    if (result.failed.length > 0) {
      return { kind: "error", detail: result.failed.map(detailFor).join("; ") };
    }
    if (result.waiting.length === 0) return { kind: "ok" };
    const signal = deps.onWaiting(result.waiting.map(deps.layerName));
    await waitForAudioFx(result.waiting, {
      stateOf: (id) => tracker.stateOf(id),
      subscribe: (cb) => tracker.subscribe(cb),
      signal,
    });
    return { kind: "ok" };
  } catch (e) {
    if (e instanceof ExportCancelled) return { kind: "cancelled" };
    if (e instanceof ExportAudioFxFailed) {
      return {
        kind: "error",
        detail: detailFor({
          layer_id: e.layerId,
          kind: e.kind,
          error: e.message,
        }),
      };
    }
    return {
      kind: "error",
      detail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    tracker.dispose();
  }
}
