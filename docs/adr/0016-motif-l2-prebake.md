---
status: accepted
---

# Motif L2 persisted pre-bake

## Context

L1 (in-RAM lookahead) can't keep up when raster throughput is the bottleneck
(stacked motifs / 4K / weak GPU): playback stutters and reopening a project
re-rasters every frame. The L2 disk layer existed in `frameCache.ts` but was
unwired — nothing read or wrote it.

## Decision

- Enable the on-disk layer under `<workspace>/Cache/raster/`, read and written
  via the fs bridge (`@/bridge/fs`) once a project is open.
- `resolveMotifFrame` is a read-only disk-first path shared by the sprite and
  prewarmer; a `MotifBaker` is the sole writer (centralized → no
  fire-and-forget LRU-eviction race).
- Two explicit triggers: a global "Pre-bake" setting (default off) and a
  per-layer "Pre-bake now". No measurement-driven auto-escalation (rejected:
  a single-raster timing mispredicts the stacked-motif case).
- PNG, not WebP (Canvas WebP is lossy; see ADR 0015). Bake at the motif's authored size (`manifest.size`); the layer's scale is applied at composite time, so it is out of the cache key.
- A baked-key index (readDir on load) gates disk reads so un-baked motifs
  pay no fs cost.

## Consequences

- Manual pre-bakes persist: PNGs are the state, honored on reload even with the
  global toggle off.
- Export reading PNGs directly is a possible follow-up, not part of this change.
- User-facing name is "Pre-bake", never "cache to disk".

## Restoring persisted coverage

ADR 0078 replaces PNGs with atomic `.wfrm` files; the files remain the durable
truth. On project open, synchronize the Motif catalog and enumerate each live
content directory before admitting preview captures or background baking.
Restore exact frame coverage, not merely directory membership: a directory may
contain an interrupted bake, old PNGs or temporary writes. Complete sequences
become ready immediately; partial sequences queue only their missing frames.
The idle baker no longer walks every saved frame through a separate IPC check.
If enumeration fails, retain the existing per-frame disk checks as a fallback.

The in-memory inventory is scoped to a project opening and extended after
successful writes. Serialized, epoch-guarded restoration prevents a superseded
project snapshot from publishing coverage or collecting live directories. An
on-demand frame waits for the same restoration barrier as the background loops.
No additional completion manifest or cache-format migration is needed.

Reuse continues to follow the existing content key: package hash (ADR 0079),
canonical props, authored size, frame rate, content duration and capture-runtime
namespace. Placement, playhead and compositing transforms do not invalidate
those pixels. A content change selects a different directory; GC retains its
existing policy of reclaiming unreferenced content, so undo after collection
may require another bake.
