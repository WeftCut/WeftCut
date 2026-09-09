import { Slider } from "@base-ui/react/slider";
import { cn } from "@/lib/utils";

interface AppSliderProps {
  value: number;
  onValueChange: (value: number) => void;
  /// Fires once on pointer release / keyboard-step settle — for
  /// commit-on-release call sites that draft via onValueChange.
  onValueCommitted?: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  /// Vertical flips the long axis and, with it, the key mapping: Base UI reads
  /// up/down as increase/decrease straight off this, so a vertical slider
  /// needs no key handling of its own. It also has no length of its own — it
  /// stretches to whatever height the call site gives it and collapses to
  /// nothing when given none.
  orientation?: "horizontal" | "vertical";
  ariaLabel?: string;
  className?: string;
}

/// The one slider for every WeftCut form. Replaces native
/// `<input type="range">` with an app-skinned track/thumb (the .app-slider*
/// classes) so all sliders look the same and pick up keyboard stepping,
/// Home/End, and pointer-anywhere-on-track jumps from Base UI.
export function AppSlider({
  value,
  onValueChange,
  onValueCommitted,
  min,
  max,
  step,
  disabled,
  orientation,
  ariaLabel,
  className,
}: AppSliderProps) {
  return (
    <Slider.Root
      className={cn("app-slider", className)}
      value={value}
      min={min}
      max={max}
      step={step ?? 1}
      disabled={disabled ?? false}
      orientation={orientation ?? "horizontal"}
      onValueChange={(v) => {
        if (typeof v === "number") onValueChange(v);
      }}
      onValueCommitted={(v) => {
        if (typeof v === "number") onValueCommitted?.(v);
      }}
    >
      <Slider.Control className="app-slider-control">
        <Slider.Track className="app-slider-track">
          <Slider.Indicator className="app-slider-indicator" />
          <Slider.Thumb className="app-slider-thumb" aria-label={ariaLabel} />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
