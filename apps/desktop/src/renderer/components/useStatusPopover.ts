// A status-bar pill's details popover: the pill toggles it, a press outside or
// Escape closes it, and Escape hands focus back to the pill. Not modal — the
// editor stays usable while it is open.

import { useCallback, useEffect, useId, useRef, useState } from "react";

export function useStatusPopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const toggle = useCallback(() => setOpen((was) => !was), []);
  const close = useCallback(() => setOpen(false), []);

  /// Spread on the pill's button.
  const triggerProps = {
    ref: buttonRef,
    "aria-expanded": open,
    "aria-controls": open ? detailsId : undefined,
    onClick: toggle,
  };

  return { open, close, rootRef, detailsId, triggerProps };
}
