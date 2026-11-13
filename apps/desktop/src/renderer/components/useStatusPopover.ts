// A status popover (the work pill, Not saved, the bell): its trigger toggles
// it, a press outside or Escape closes it, and Escape hands focus back to the
// trigger. Not modal — the editor stays usable while it is open. One is open
// at a time: opening one closes the other, whether by pointer or keyboard.

import { useCallback, useEffect, useId, useRef, useState } from "react";

const OPENED = "weftcut:status-popover-open";

export function useStatusPopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(OPENED, { detail: detailsId }));
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const closeForAnother = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== detailsId) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener(OPENED, closeForAnother);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
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

  return { open, close, rootRef, detailsId, triggerProps };
}
