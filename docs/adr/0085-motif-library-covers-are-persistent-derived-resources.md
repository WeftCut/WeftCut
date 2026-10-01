---
status: accepted
---

# Motif library covers are persistent derived resources

## Context

Every picker card previously requested a full document capture on each mount.
The list competed with the selected preview and playback for the single capture
host, including Motifs outside the scrolling viewport. Package export acted on
the selection from a list-level toolbar; deletion existed behind IPC/MCP but
was not reachable from the library.

## Decision

- Main owns a `MotifCovers` module. Its get interface takes an identity and the
  catalog's expected content hash and returns actual PNG pixels. It resolves
  the authoritative package, reads a persisted cover or shares an in-flight
  capture. React owns visibility and object-URL lifetime only.
- Covers use default props, the settled entrance time (or time zero for a
  continuous Motif), and a fixed 30 fps independent of the current project.
  Capture uses the authored viewport and existing low-priority CDP queue.
  Only the resulting PNG is reduced to fit 480×270, retaining transparency.
  The selected form keeps its full-size, project-fps parameter preview.
- The cache key includes the complete package content hash (ADR 0079), the
  cover recipe version, Chromium version and clock-runtime source digest.
  Source changes during capture reject the result. Failed requests are retryable.
- Each identity owns one atomic cache slot under the data root's
  `cache/motif-covers/`, independent of project frame bakes. Corrupt slots
  regenerate; persistence failures still return the current image. Startup
  reclaims slots for removed identities and interrupted temporary writes.
  Generated covers never enter source packages, content hashes or exported ZIPs.
- The list requests covers only for visible/near-visible cards. Each card has
  Export, and its pointer/keyboard context menu exposes the same Export plus
  Delete for installed Motifs and drafts. Built-ins have no Delete item and
  remain protected by the existing backend rule. Deletion confirms its existing
  cross-project missing-placeholder semantics, then refreshes the catalog and
  repairs selection. All actions target the acted-on identity, not a possibly
  different selected card.

## Consequences

Warm list openings need image reads rather than document rendering. A changed
Motif or capture runtime regenerates lazily. Covers are regenerable local
resources, not an authored manifest field or another rendering engine. Catalog
metadata and lifecycle operations remain on their existing interfaces.

Verification includes cache/coalescing/recovery tests, picker interaction tests,
and real Electron restarts proving identical saved pixels without a capture
window, followed by asset-only invalidation.
