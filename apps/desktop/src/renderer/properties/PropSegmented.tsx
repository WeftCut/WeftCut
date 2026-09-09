import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/// A one-of-N choice as adjacent buttons: the selected one filled
/// (`secondary`), the rest quiet (`ghost`). For a small, stable set of modes
/// where seeing the alternatives is the point — you read what else this
/// property could be without opening anything.
///
/// Wraps rather than squashes: three word labels do not fit the inspector's
/// value column at every panel width, and a segment whose label is clipped is
/// worse than a second line.
///
/// The group carries the accessible name, so each button needs only its own
/// label. Deliberately buttons and not a `<select>`: a select hides the
/// alternatives behind a click and reads as "a value to pick", where these are
/// modes the layer is IN.
export function PropSegmented<T extends string>({
  label,
  value,
  options,
  onSelect,
}: {
  /// Accessible name for the group — what the choice is about.
  label: string;
  value: T | null;
  options: readonly {
    value: T;
    label: string;
    /// Why this option is unavailable. Present ⇒ the segment is disabled and
    /// says so on hover, rather than being silently dead.
    unavailable?: string;
  }[];
  onSelect: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn(
            buttonVariants({ variant: option.value === value ? "secondary" : "ghost", size: "xs" }),
          )}
          aria-pressed={option.value === value}
          disabled={option.unavailable !== undefined}
          {...(option.unavailable !== undefined ? { title: option.unavailable } : {})}
          onClick={() => onSelect(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
