import { useEffect, useMemo } from "react";

/// A zero-size virtual element at the cursor, for a floating context menu's
/// `anchor` (Base UI `Positioner`). Shared by every right-click menu here so a
/// second one cannot drift into different popup geometry from the first.
export function useCursorAnchor(x: number, y: number) {
  return useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x,
        y,
        top: y,
        left: x,
        right: x,
        bottom: y,
        width: 0,
        height: 0,
      }),
    }),
    [x, y],
  );
}

/// Close a cursor-anchored popup when the content it points at actually MOVES.
///
/// Every context menu here is placed at fixed viewport coordinates, so it goes
/// stale the moment its subject scrolls out from under it. The obvious handler —
/// close on any `scroll` event — reads a proxy instead of the fact, and the
/// proxy lies: opening a Base UI popup fires a `scroll` on the right-clicked
/// element's own scroll container a few milliseconds AFTER the popup mounts,
/// with the container's offset unchanged, because the popup takes focus and
/// Chromium dispatches the event for a scroll-into-view that resolved to no
/// movement. Measured in the real app at both DPR 1 and a fractional one:
/// mount at 45.5 ms, `scroll` at 51.2 ms, `scrollTop` 35 on both sides of it.
///
/// So a menu opened on a row in a partly-scrolled list dismissed ITSELF, ~6 ms
/// in, and whether the user ever saw it came down to which of the two handlers
/// won a race the platform decides — green on Linux, flaky on macOS, red every
/// time on Windows.
///
/// Comparing the anchor's rect states the actual rule and cannot be raced: a
/// zero-delta event leaves the anchor where it was and is ignored; a real
/// scroll moves it and closes. `anchor` may be null (nothing open), and `close`
/// must be stable or the baseline is re-taken on every render.
export function useCloseOnAnchorMove(
  anchor: HTMLElement | null,
  close: () => void,
): void {
  useEffect(() => {
    if (!anchor) return;
    const { top, left } = anchor.getBoundingClientRect();
    const onScroll = () => {
      const now = anchor.getBoundingClientRect();
      // A whole CSS pixel of slack: at a fractional device-pixel ratio two
      // reads of an unmoved rect differ in the sub-pixel digits, and no move
      // that small can detach a popup from anything.
      if (Math.abs(now.top - top) > 1 || Math.abs(now.left - left) > 1) close();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [anchor, close]);
}
