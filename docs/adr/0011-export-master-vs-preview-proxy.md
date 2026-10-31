---
status: accepted
---

# Export master vs. preview proxy: two derivatives, two roles

Date: 2026-05-31

## Context

Some sources cannot be exported from the original by the export decode path:
ProRes, MPEG-2, and 10-bit/HDR footage that WebCodecs cannot decode.
Those sources need a transcoded intermediate. A single proxy capped at 1080p
served both preview and export, and it silently downscaled 4K exports. Raising
the cap would make preview scrub a 4K stream, which is the throughput problem a
proxy exists to avoid. A 4K master encode is also slow. If editing waited for
it, a large import would block the timeline for minutes.

## Decision

- **Quick proxy = preview only.** `jobs/quick_proxy.rs` writes a ≤720p H.264
  file with a short fixed GOP (`PROXY_GOP_FRAMES`). It remuxes when the source
  is already friendly H.264 with a short GOP, and otherwise uses a libx264
  ultrafast transcode. It lands first, so the clip becomes editable within
  seconds. Export never reads it.
- **Full proxy = export master only.** `jobs/proxy.rs` writes source-resolution
  H.264 (`scale=-2:'min(ih,2160)'`, High, CRF 18, `-bf 0`). Preview never reads
  it.
- Every source whose export needs the master generates both, quick first
  (`ProxyJob::QuickThenFull`). The quick proxy is kept after the master lands.
- If the master is missing, export reports an error and waits for it. It does
  not fall back to the quick proxy. A failed master is re-enqueued on the next
  workspace open.

## Consequences

- A clip can be editable (quick proxy ready) but not yet exportable (master
  pending or failed). This asymmetry is intentional.
- Local cache use is higher: up to two derivatives per such source.
- The master is a lossy CRF-18 intermediate, so its exports are not
  original quality. HDR stays 8-bit in the master. When the Standard engine
  is available, export decodes these originals natively instead (ADR 0033).
- A master format change bumps `FULL_PROXY_FORMAT_VERSION`. Stale masters are
  then invalidated on open and regenerated.

Rejected: one proxy for both roles (either a 1080p cap degrades exports, or a
4K cap makes scrubbing heavy); exporting from the quick proxy when the master
is missing (silently lowers output quality).
