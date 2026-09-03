import { Pipette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { pickColor } from "../colorpick/pickColor";
import type { Rgba } from "../ipc";

/// The `Rgba` ↔ hex bridge every caller of this field needs, kept beside the
/// field because the hex string IS its value contract. Alpha never crosses:
/// `<input type="color">` edits the RGB triplet only, so the caller supplies
/// the alpha to carry through.
export function rgbaToHex(c: Rgba): string {
  return `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/// A malformed hex reads as white rather than throwing: the value comes from a
/// DOM input, and a layer that briefly looks wrong beats a render that crashes.
export function hexToRgba(hex: string, a: number): Rgba {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) return { r: 255, g: 255, b: 255, a };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a };
}

export interface AppColorFieldProps {
  /// Hex string, e.g. "#aabbcc". The native picker edits the RGB triplet only.
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  /// Global eyedropper button next to the swatch (default on). Opt out only
  /// where the extra 24px genuinely cannot fit.
  withEyeDropper?: boolean;
}

/// The one color swatch for every WeftCut form. A skinned native
/// `<input type="color">` — keeps the OS picker (no custom popover). Does NOT
/// debounce: callers whose commit triggers an expensive re-render (e.g. PropertyPanel
/// CDP re-capture) must keep their own debounce. The eyedropper commits through
/// the same onValueChange, so caller debounce policy applies to picks too.
export function AppColorField({
  value,
  onValueChange,
  disabled,
  ariaLabel,
  className,
  withEyeDropper = true,
}: AppColorFieldProps) {
  const { t } = useTranslation();
  const input = (
    <input
      type="color"
      className={cn("app-color-swatch", className)}
      value={value}
      disabled={disabled ?? false}
      aria-label={ariaLabel}
      onChange={(e) => onValueChange(e.target.value)}
    />
  );
  if (!withEyeDropper) return input;
  // Input BEFORE button: the input must stay this <span>'s first labelable
  // descendant — consumers render AppColorField inside a <label>, and the
  // label's activation target follows DOM order (see PropertyPanel's
  // Tooltip.Trigger comment for the same trap).
  return (
    <span className="app-color-field">
      {input}
      <button
        type="button"
        className="app-color-pick"
        disabled={disabled ?? false}
        aria-label={t("colorpick.pick")}
        onClick={() => {
          void pickColor()
            .then((r) => {
              if (r) onValueChange(r.hex);
            })
            .catch((e) => console.warn("colorpick:", e));
        }}
      >
        <Pipette size={12} />
      </button>
    </span>
  );
}
