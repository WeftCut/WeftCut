import {
  audioFxReverify,
  getWaveformLevels,
  getWaveformTile,
  parseFxWaveformKey,
  type WaveformLevels,
} from "../../ipc";
import {
  ERROR_RETRY_COOLDOWN_MS,
  tileEngine,
  type TileEngine,
  type TileKey,
} from "./TileEngine";

export const WAVEFORM_KIND = "waveform";
/// One fetched tile = this many (min,max,rms) windows. Bounds IPC payload size.
export const TILE_PEAKS = 2048;
/// Aim for ~1.5 timeline px per peak window at the chosen LOD.
export const PX_PER_PEAK_TARGET = 1.5;
/// Engine-side budget for waveform tiles (~48 KB each -> ~680 tiles, far
/// above what the viewport-bounded fetch can request at once).
export const WAVEFORM_TILE_BUDGET_BYTES = 32 * 1024 * 1024;

/// Which peaks artifact a strip reads.
///
/// `mediaId` is what main resolves the media item from and never varies with
/// the chain; `waveformKey` picks WHICH of that media's peaks files to read —
/// the media id itself for the raw conform, or an `fx:` key naming a baked
/// effect-chain sibling (`shared/audioEffects/status.ts` `fxWaveformKey`).
/// `layerId` owns that chain, and is the reverify target when its artifact has
/// gone missing; a raw-conform key has nothing to re-verify.
export interface WaveformSource {
  mediaId: string;
  waveformKey: string;
  layerId?: string | undefined;
}

/// A bare media id means the raw conform — the shape every caller that knows
/// nothing about effect chains passes.
export type WaveformSourceLike = string | WaveformSource;

function asSource(source: WaveformSourceLike): WaveformSource {
  return typeof source === "string"
    ? { mediaId: source, waveformKey: source }
    : source;
}

/// The baked-sibling key for a source, or undefined when it reads the media's
/// own raw-conform waveform. Serves as both the tile-slot identity and the IPC
/// argument: main ignores any key that isn't an `fx:` one, and normalising to
/// undefined keeps ONE slot per artifact whether the caller named the media id
/// or passed it as the waveform key.
function fxKeyOf(source: WaveformSource): string | undefined {
  return parseFxWaveformKey(source.waveformKey) === null
    ? undefined
    : source.waveformKey;
}

/// The backend's "the peaks file isn't there" refusal, whichever shape it
/// arrives in: a bare string from a direct backend reject, or an Error whose
/// message the IPC layer has wrapped (`TileEngine.request` classifies the same
/// way). Every other rejection is transient and retried instead.
function isNotReady(e: unknown): boolean {
  return (typeof e === "string" ? e : String(e)).includes("not_ready");
}

/// Index of the coarsest level whose density still meets the on-screen demand,
/// so we ship the least data that looks crisp. Levels are finest-first.
export function chooseLevel(
  levels: WaveformLevels["levels"],
  pxPerSec: number,
): number {
  const desired = pxPerSec / PX_PER_PEAK_TARGET;
  let chosen = 0; // finest fallback
  for (let i = levels.length - 1; i >= 0; i--) {
    if (levels[i]!.peaksPerSecond >= desired) { chosen = i; break; }
  }
  return chosen;
}

export function tileRangeForWindow(
  // Must be the exact effective LOD density (sampleRate / framesPerPeak).
  // Rounding this value causes an error that grows with source time.
  peaksPerSecond: number,
  srcInUs: number,
  srcOutUs: number,
): { firstTile: number; lastTile: number; startPeak: number; endPeak: number } {
  const lo = Math.min(srcInUs, srcOutUs);
  const hi = Math.max(srcInUs, srcOutUs);
  const startPeak = Math.max(0, Math.floor((lo / 1_000_000) * peaksPerSecond));
  const endPeak = Math.max(startPeak + 1, Math.ceil((hi / 1_000_000) * peaksPerSecond));
  return {
    startPeak,
    endPeak,
    firstTile: Math.floor(startPeak / TILE_PEAKS),
    lastTile: Math.floor((endPeak - 1) / TILE_PEAKS),
  };
}

export interface WaveformWindow {
  peaksPerSecond: number;
  startPeak: number;
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
}

interface TileValue {
  peaksPerSecond: number;
  min: number[];
  max: number[];
  rms: number[];
}

// Level tables are cheap and stable per generated waveform file; cache them so
// we don't re-read the header on every window assembly. Keyed by WAVEFORM key
// and not by media: one media can have a raw table and a baked one per chain,
// and they differ. NOT immutable forever: a regenerated waveform
// (media:job_complete) gets a fresh table, so the producer's `invalidate` hook
// below must drop the entry.
const levelsCache = new Map<string, Promise<WaveformLevels>>();
function fetchLevels(source: WaveformSource): Promise<WaveformLevels> {
  const cacheKey = source.waveformKey;
  let p = levelsCache.get(cacheKey);
  if (!p) {
    p = getWaveformLevels(source.mediaId, fxKeyOf(source)).catch((e) => {
      levelsCache.delete(cacheKey);
      throw e;
    });
    levelsCache.set(cacheKey, p);
  }
  return p;
}

/// When each waveform key last had a reverify asked for it.
const reverifiedAtMs = new Map<string, number>();

/// A baked sibling the backend can't resolve — evicted by the cache LRU, or
/// deleted under us — reads as `not_ready`, exactly like a media whose waveform
/// has never been generated. Ask the baker to re-check the disk (it re-bakes
/// and republishes the SAME key, since the signature hasn't changed) and drop
/// the stale level table so the retry re-reads the header.
///
/// Cooldown-gated per key, on the tile engine's own error-retry reasoning: one
/// strip fans out to a request per visible segment per channel, and every one
/// of them lands here.
function noteFxArtifactMissing(source: WaveformSource): void {
  const key = source.waveformKey;
  levelsCache.delete(key);
  const layerId = source.layerId;
  if (layerId === undefined) return;
  const now = Date.now();
  if (now - (reverifiedAtMs.get(key) ?? -Infinity) < ERROR_RETRY_COOLDOWN_MS) {
    return;
  }
  reverifiedAtMs.set(key, now);
  void audioFxReverify(layerId).catch(() => {
    // Best effort: the strip is already drawing the raw waveform, and the next
    // pass past the cooldown asks again.
  });
}

let registered = false;
export function registerWaveformProducer(engine: TileEngine = tileEngine): void {
  if (registered) return;
  registered = true;
  engine.register<TileValue>({
    kind: WAVEFORM_KIND,
    budgetBytes: WAVEFORM_TILE_BUDGET_BYTES,
    // `lod` encodes level; `index` encodes channel*BIG + tileIndex.
    fetch: async (key: TileKey) => {
      const channel = Math.floor(key.index / 1_000_000);
      const tileIndex = key.index % 1_000_000;
      const tile = await getWaveformTile(
        key.mediaId, key.lod, channel, tileIndex * TILE_PEAKS, TILE_PEAKS,
        key.sourceKey,
      );
      return { peaksPerSecond: tile.peaksPerSecond, min: tile.min, max: tile.max, rms: tile.rms };
    },
    bytes: (v) => (v.min.length + v.max.length + v.rms.length) * 8,
    invalidate: (mediaId) => { levelsCache.delete(mediaId); },
  });
}

function tileKey(
  source: WaveformSource,
  level: number,
  channel: number,
  tileIndex: number,
): TileKey {
  return {
    mediaId: source.mediaId,
    sourceKey: fxKeyOf(source),
    kind: WAVEFORM_KIND,
    lod: level,
    index: channel * 1_000_000 + tileIndex,
  };
}

/// Request + assemble the min/max/rms envelope for a src window at the LOD that
/// suits `pxPerSec`. Returns "pending" until every covering tile is ready, or
/// "not_ready" if the waveform file isn't generated yet.
///
/// A baked sibling that has gone missing degrades to the media's raw waveform
/// for THIS render instead of drawing nothing: the picture is then one bake
/// behind, which is what stale-while-revalidate looks like everywhere else in
/// this feature (ADR 0063).
export async function ensureWaveformWindow(
  source: WaveformSourceLike,
  channel: number,
  srcInUs: number,
  srcOutUs: number,
  pxPerSec: number,
  engine: TileEngine = tileEngine,
): Promise<WaveformWindow | "pending" | "not_ready"> {
  const resolved = asSource(source);
  const result = await windowFor(resolved, channel, srcInUs, srcOutUs, pxPerSec, engine);
  if (result !== "not_ready" || fxKeyOf(resolved) === undefined) return result;
  noteFxArtifactMissing(resolved);
  return windowFor(
    { mediaId: resolved.mediaId, waveformKey: resolved.mediaId },
    channel, srcInUs, srcOutUs, pxPerSec, engine,
  );
}

async function windowFor(
  source: WaveformSource,
  channel: number,
  srcInUs: number,
  srcOutUs: number,
  pxPerSec: number,
  engine: TileEngine,
): Promise<WaveformWindow | "pending" | "not_ready"> {
  let levels: WaveformLevels;
  try {
    levels = await fetchLevels(source);
  } catch (e) {
    return isNotReady(e) ? "not_ready" : "pending";
  }
  if (levels.levels.length === 0) return "not_ready";

  const level = chooseLevel(levels.levels, pxPerSec);
  // Keep the backend's fractional density all the way through range selection
  // and rendering. In particular, 22050 Hz / 352 frames is
  // 62.642045... peaks/s, not 62 peaks/s.
  const pps = levels.levels[level]!.peaksPerSecond;
  const { firstTile, lastTile, startPeak, endPeak } = tileRangeForWindow(pps, srcInUs, srcOutUs);

  // Request all covering tiles; collect ready ones.
  const tiles: (TileValue | null)[] = [];
  let anyMissing = false;
  let notReady = false;
  for (let t = firstTile; t <= lastTile; t++) {
    const key = tileKey(source, level, channel, t);
    const entry = engine.get<TileValue>(key);
    if (!entry) { engine.request(key); anyMissing = true; tiles.push(null); continue; }
    if (entry.state === "ready") { tiles.push(entry.value); continue; }
    if (entry.state === "not_ready") { notReady = true; tiles.push(null); continue; }
    if (entry.state === "error") { engine.request(key); anyMissing = true; tiles.push(null); continue; }
    // pending -> treat as missing
    anyMissing = true;
    tiles.push(null);
  }
  if (notReady) return "not_ready";
  if (anyMissing || tiles.some((x) => x === null)) return "pending";

  // Assemble the [startPeak, endPeak) slice.
  const total = endPeak - startPeak;
  const min = new Float32Array(total);
  const max = new Float32Array(total);
  const rms = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const globalPeak = startPeak + i;
    const t = Math.floor(globalPeak / TILE_PEAKS);
    const within = globalPeak % TILE_PEAKS;
    const tile = tiles[t - firstTile]!;
    min[i] = tile.min[within] ?? 0;
    max[i] = tile.max[within] ?? 0;
    rms[i] = tile.rms[within] ?? 0;
  }
  return { peaksPerSecond: pps, startPeak, min, max, rms };
}

/// Channel count for a source's waveform, shared with `ensureWaveformWindow`'s
/// level-table cache (and therefore its invalidation on regeneration). Falls
/// back to the raw waveform on the same missing-sibling rule as the window
/// assembly, so a strip never draws two channels of one artifact and a mono
/// lane of the other.
export async function getWaveformChannelCount(
  source: WaveformSourceLike,
): Promise<number> {
  const resolved = asSource(source);
  try {
    return (await fetchLevels(resolved)).channels;
  } catch (e) {
    if (!isNotReady(e) || fxKeyOf(resolved) === undefined) throw e;
    noteFxArtifactMissing(resolved);
    return (
      await fetchLevels({
        mediaId: resolved.mediaId,
        waveformKey: resolved.mediaId,
      })
    ).channels;
  }
}
