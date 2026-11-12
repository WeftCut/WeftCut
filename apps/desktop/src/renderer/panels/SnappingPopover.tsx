import { Grid3x3 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { AppIcon } from "../components/AppIcon";
import { setAppSettings, usePreviewGrid } from "../settings/appSettingsStore";
import { PreviewGridDimensions } from "../settings/SnapSettings";
import type { StripOrientation } from "./QuickActionsPanel";

const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 240;
const POPUP_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 5;

type Placement = { left: number; top: number };

/** A hover-only, portalled editor. Click on the icon toggles snapping, never
 * menu state. This avoids the press-to-pin behaviour of Popover.Trigger,
 * which otherwise leaves a hover popup stuck open after clicking the icon. */
export function SnappingPopover({ orientation, tabbable, onFocus }: {
  orientation: StripOrientation;
  tabbable: boolean;
  onFocus: () => void;
}) {
  const { t } = useTranslation();
  const grid = usePreviewGrid();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardOpening = useRef(false);
  const popupId = useId();
  const label = t("quick_actions.snapping_grid");

  const cancelOpen = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const beginHover = () => {
    cancelClose();
    cancelOpen();
    if (open) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, OPEN_DELAY_MS);
  };
  const endHover = () => {
    cancelOpen();
    cancelClose();
    // Give the pointer time to cross the gap between the trigger and portal.
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
      setPosition(null);
    }, CLOSE_DELAY_MS);
  };
  const close = () => {
    cancelOpen();
    cancelClose();
    setOpen(false);
    setPosition(null);
    setError("");
  };

  useEffect(() => () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const popup = popupRef.current?.getBoundingClientRect();
      if (!trigger || !popup) return;
      const clamp = (value: number, max: number) =>
        Math.min(Math.max(value, VIEWPORT_MARGIN_PX), Math.max(VIEWPORT_MARGIN_PX, max));
      let left: number;
      let top: number;
      if (orientation === "vertical") {
        left = trigger.right + POPUP_GAP_PX;
        if (left + popup.width > window.innerWidth - VIEWPORT_MARGIN_PX) {
          left = trigger.left - popup.width - POPUP_GAP_PX;
        }
        top = trigger.top;
      } else {
        left = trigger.left;
        // A horizontal strip can sit at the top of the Dock workspace while
        // still having enough *window* space above it for the popup (the app
        // toolbar lives there). Prefer below for that top-docked strip; on
        // other horizontal rows, prefer above as before. Do not decide using
        // the trigger's viewport Y alone.
        const workspace = triggerRef.current?.closest(".dock-workspace")?.getBoundingClientRect();
        const strip = triggerRef.current?.closest(".weft-dock-panel")?.getBoundingClientRect();
        const atWorkspaceTop = !!workspace && !!strip &&
          Math.abs(strip.top - workspace.top) <= 24;
        const above = trigger.top - popup.height - POPUP_GAP_PX;
        const below = trigger.bottom + POPUP_GAP_PX;
        top = atWorkspaceTop || above < VIEWPORT_MARGIN_PX ? below : above;
        // If a very short window has no room below, fall back above.
        if (top === below && below + popup.height > window.innerHeight - VIEWPORT_MARGIN_PX &&
            above >= VIEWPORT_MARGIN_PX) top = above;
      }
      const next = {
        left: clamp(left, window.innerWidth - popup.width - VIEWPORT_MARGIN_PX),
        top: clamp(top, window.innerHeight - popup.height - VIEWPORT_MARGIN_PX),
      };
      setPosition((previous) =>
        previous?.left === next.left && previous.top === next.top ? previous : next);
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    if (keyboardOpening.current) {
      keyboardOpening.current = false;
      popupRef.current?.querySelector<HTMLInputElement>("input.app-number-input")?.focus();
    }
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, orientation, error]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    const onOutsidePointer = (event: PointerEvent) => {
      if (triggerRef.current?.contains(event.target as Node) ||
          popupRef.current?.contains(event.target as Node)) return;
      close();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onOutsidePointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onOutsidePointer, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="weft-quick-action"
        data-quick-action="snappingOptions"
        data-active={grid.snap}
        aria-pressed={grid.snap}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        title={label}
        tabIndex={tabbable ? 0 : -1}
        onFocus={onFocus}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse" || event.pointerType === "pen") beginHover();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse" || event.pointerType === "pen") endHover();
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
            if (event.key === "ArrowDown") event.preventDefault();
            cancelClose();
            keyboardOpening.current = true;
            setOpen(true);
          }
        }}
        onClick={() => {
          setError("");
          void setAppSettings({ preview_grid: { snap: !grid.snap } })
            .catch((cause) => setError(String(cause)));
        }}
      >
        <AppIcon icon={Grid3x3} size="heading" aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={popupRef}
          id={popupId}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          className="app-menu-list quick-snapping-popup"
          style={{
            position: "fixed",
            zIndex: "var(--layer-menu)",
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position ? "visible" : "hidden",
          }}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse" || event.pointerType === "pen") cancelClose();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse" || event.pointerType === "pen") endHover();
          }}
        >
          <PreviewGridDimensions onError={setError} />
          {error && <p className="settings-error" role="alert">{error}</p>}
        </div>,
        document.body,
      )}
    </>
  );
}
