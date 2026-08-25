import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { XIcon } from "lucide-react";

interface AppDialogProps {
  /// Rendered as the <h2> inside <header> that the legacy panel CSS
  /// (`.settings-panel header h2` etc.) targets; Base UI wires it to the
  /// popup's aria-labelledby.
  title: ReactNode;
  /// Close callback for ✕ / Escape / backdrop click. Omit to make the
  /// dialog undismissable (export-in-progress): every close request is
  /// ignored until the caller re-renders with `onClose` set or unmounts.
  onClose?: (() => void) | undefined;
  /// Set false to draw no ✕ at all — for a dialog that stays dismissable by
  /// Escape and backdrop while an in-flight operation must not be abandoned
  /// mid-click, and for the new-project dialog, which closes via its footer
  /// buttons and backdrop only. A dialog with no `onClose` has no ✕ either
  /// way, so `saving ? undefined : handler` needs nothing here.
  showClose?: boolean | undefined;
  /// Legacy panel skin: "settings-panel", "motif-picker", ...
  /// The popup carries only centering; the
  /// panel class owns size/background/border/shadow.
  panelClassName: string;
  /// Extra header controls between the title and ✕ (MotifPicker's
  /// new/import buttons).
  headerExtra?: ReactNode;
  children: ReactNode;
}

/// The one modal wrapper for every WeftCut dialog. Base UI supplies the
/// portal, focus trap, Escape close, backdrop dismiss, and aria wiring.
/// Callers conditionally render the whole dialog (mount == open), so `open`
/// is always true here and closing happens by the parent unmounting us.
export function AppDialog({
  title,
  onClose,
  showClose = true,
  panelClassName,
  headerExtra,
  children,
}: AppDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      disablePointerDismissal={onClose === undefined}
      onOpenChange={(open) => {
        // Undismissable dialogs (no onClose) ignore every close request —
        // Escape included — so `open` stays true until the caller unmounts.
        if (!open) onClose?.();
      }}
    >
      <DialogPortal>
        {/* Match the legacy flat rgba(0,0,0,0.5) backdrop (no blur). */}
        <DialogOverlay className="bg-black/50 supports-backdrop-filter:backdrop-blur-none" />
        <DialogPrimitive.Popup
          className={cn(
            "fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 outline-none",
            panelClassName,
          )}
        >
          <header>
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            {headerExtra}
            {onClose !== undefined && showClose && (
              <button
                type="button"
                className="settings-close"
                onClick={onClose}
                // Named for what it does to the dialog, not for the footer
                // button it duplicates: two controls sharing one accessible
                // name is what a screen reader reads twice.
                aria-label={t("modal.close")}
              >
                <XIcon size={16} aria-hidden />
              </button>
            )}
          </header>
          {children}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
