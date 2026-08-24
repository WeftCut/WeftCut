// The timeline's wheel-to-axis mapping, kept pure so the rules can be tested
// without a layout (jsdom lays nothing out and swallows every `scrollLeft`
// write — see `hooks/useFollowPlayhead.test.ts`). The listener that applies a
// plan lives in `hooks/useWheelScroll.ts`; the zoom gesture that owns the
// modified wheel lives in `hooks/useTimelineView.ts`.

import type { TimelineWheelAxis } from "../ipc";

/// `deltaMode` DOM_DELTA_LINE / DOM_DELTA_PAGE in CSS pixels. The raw delta
/// numbers are incomparable between modes, so every wheel consumer normalises
/// through `wheelPixels` before it computes anything — a line-mode mouse
/// otherwise moves the timeline by 3 px a notch and reads as broken.
const LINE_PX = 16;
const PAGE_PX = 100;

/// One axis of a wheel event in CSS pixels. Shared by the scroll mapping here
/// and the zoom factor in `hooks/useTimelineView.ts` so the two gestures cannot
/// drift in what a notch means.
export function wheelPixels(delta: number, deltaMode: number): number {
  return delta * (deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1);
}

/// The part of a WheelEvent the mapping reads. A structural type, not the DOM
/// one, so tests can hand it a literal.
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/// A scroll to apply to the timeline's scroll root, in CSS pixels.
export interface WheelScroll {
  dx: number;
  dy: number;
}

/// What a wheel event should do to the timeline, or `null` for "not ours" —
/// leave the event untouched and let Chromium's own scrolling run.
export function wheelScrollPlan(
  e: WheelLike,
  axis: TimelineWheelAxis,
): WheelScroll | null {
  // Ctrl and Alt belong to the zoom gesture. Both handlers key on the MODIFIER
  // rather than on `defaultPrevented`, so precedence doesn't depend on which
  // effect happened to register its listener first.
  if (e.ctrlKey || e.altKey) return null;

  // Vertical mode IS Chromium's default behaviour — bare wheel down the track
  // stack, Shift across time. Claiming those events to reimplement them would
  // buy nothing and cost the platform's scroll smoothing and momentum.
  if (axis === "vertical") return null;

  const py = wheelPixels(e.deltaY, e.deltaMode);
  const px = wheelPixels(e.deltaX, e.deltaMode);

  // Shift is "the other axis", which in horizontal mode means vertical — and it
  // MUST be claimed rather than passed through: left alone, Chromium applies
  // its own Shift rule and scrolls horizontally, the very axis the user
  // modified away from. WHICH delta field carries the amount under Shift is a
  // platform detail (Chromium moves the wheel onto `deltaX` on some builds), so
  // take whichever one is populated instead of assuming either.
  if (e.shiftKey) {
    const amount = py !== 0 ? py : px;
    return amount === 0 ? null : { dx: 0, dy: amount };
  }

  // A gesture that already carries a horizontal component is a trackpad's
  // two-finger sideways swipe: it is ALREADY moving along time, and remapping
  // `deltaY` on top of it would double the horizontal travel. Handing it back
  // to the platform also keeps the trackpad's momentum, which one
  // `scrollLeft +=` per event cannot reproduce.
  if (px !== 0) return null;
  if (py === 0) return null;
  return { dx: py, dy: 0 };
}
