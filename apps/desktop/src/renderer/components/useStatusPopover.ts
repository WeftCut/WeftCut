// A status popover (the work pill, Not saved, the bell): its trigger toggles
// it, a press outside or Escape closes it, and Escape hands focus back to the
// trigger. Not modal — the editor stays usable while it is open. One is open
// at a time: opening one closes the other, whether by pointer or keyboard. A
// popover whose trigger leaves the bar (the work ends, the save recovers)
// closes with it, so it never comes back open on its own.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { isInTransientWidget } from "../shortcuts/match";

const OPENED = "weftcut:status-popover-open";

export function useStatusPopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();

  // The anchor wraps the trigger and the popover: when it unmounts, the
  // popover has nothing left to belong to.
  const anchorRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (node === null) setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(OPENED, { detail: detailsId }));
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // Escape is this popover's while it is open: consumed before the window's
    // listeners, or the same press would also restore a maximized panel or
    // leave blade mode. A menu or dialog holding focus keeps its own Escape.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isInTransientWidget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      // Focus goes back only from inside; a user who tabbed elsewhere keeps it.
      const focused = document.activeElement;
      if (focused === null || focused === document.body || rootRef.current?.contains(focused)) {
        buttonRef.current?.focus();
      }
    };
    const closeForAnother = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== detailsId) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape, true);
    window.addEventListener(OPENED, closeForAnother);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape, true);
      window.removeEventListener(OPENED, closeForAnother);
    };
  }, [open, detailsId]);

  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback(() => setOpen(false), []);

  /// Spread on the trigger button.
  const triggerProps = {
    ref: buttonRef,
    "aria-expanded": open,
    "aria-controls": open ? detailsId : undefined,
    onClick: toggle,
  };

  return { open, close, rootRef: anchorRef, detailsId, triggerProps };
}
