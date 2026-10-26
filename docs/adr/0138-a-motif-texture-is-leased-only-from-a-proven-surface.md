---
status: accepted
---

# A Motif texture is leased only from a proven surface

Date: 2026-10-26

## Context

ADR 0078 found that the first shared-texture capture after a navigation could
return the offscreen compositor's previous or uninitialised surface, even
after the page's own two native rAFs had settled: rAFs fence layout and
commit, not the compositor's raster. The fix fenced that one case with a full
`Page.captureScreenshot` readback, keyed on "the host has no last size yet".

That rule described one trigger, not the invariant. Anything that gives the
compositor a new surface has the same first-paint hazard: a new size on the
same page (an MCP or cover capture at a non-authored size followed by the
authored size), and a GPU process restart. The rule also lived in the capture
host's frame function next to the clock and render steps, while the lease of
the surface lived in `OffscreenFrames`; two modules shared one invariant and
the gap sat between them.

## Decision

- **The OSR lease owns surface provenance.** `OffscreenFrames` leases a
  shared texture only from a surface it has fenced at the requested size. It
  observes main-frame navigations itself and treats a size change as a new
  surface; a GPU process restart is reported to it. The capture host passes
  the fence (a full screenshot readback) and cannot skip it.
- **The fence is paid per surface, never per frame.** A proven surface at an
  unchanged size is leased without a readback, so sustained capture keeps
  its cost; the readback recurs only on the events that create a surface.
- **A clipped readback is not a fence.** Unchanged from ADR 0078: it only
  fences its own raster tiles.

## Consequences

- One readback per navigation, per size change and per GPU restart. The
  first two were already paid or rare; the third did not exist.
- The capture host's frame function no longer carries fence state
  (`firstPaint`, `fenceFirstSurface`): its job is the clock and the render,
  and the lease's job is the surface.
- The frame cache key namespace (`surface-v3`) does not change: frames
  already baked from a proven surface are unaffected, and no earlier
  mechanism produced frames this one would now reject.
- The PNG path takes no lease and is unchanged here. Its own readback is
  the screenshot; the macOS non-determinism turned out to be the host
  window's size disagreeing with the page's emulated size, not an
  unsynchronised readback (ADR 0142).

## Validation

Unit tests fence once per new surface (navigation, size change, `surfaceChanged()`)
and never for same-document or subframe navigations. On a Windows 11 host
(RTX 3050) the capture e2e rebuilt the shared-texture host three times after
induced timeouts; the first lease from each rebuilt surface returned an opaque
frame, and all 44 captures across both tests were texture leases with no PNG
fallback.
