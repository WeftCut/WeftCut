import { AppSelectPositioner } from "./PopupPositioner";
import type { ReactNode } from "react";
import { Select } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AppIcon } from "@/components/AppIcon";

export interface AppSelectOption {
  value: string;
  label: ReactNode;
  /// Trailing popup-only annotation (e.g. a "Recommended" tag). The trigger
  /// shows `label` alone.
  detail?: ReactNode;
  disabled?: boolean;
}

interface AppSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: AppSelectOption[];
  /// Extra trigger classes on top of the shared `.app-select` skin —
  /// context rules like `.export-select` (min-width) hang off this.
  className?: string;
  popupClassName?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /// Trigger text while `value` matches no option, e.g. `""` on a picker that
  /// acts on choice and never holds a selection.
  placeholder?: ReactNode;
}

/// The one dropdown control for every WeftCut form. Replaces native
/// `<select>`: the popup is app-styled (reusing the app-menu-list/app-menu-item
/// chrome instead of the OS-rendered list), keyboard/typeahead behavior
/// comes from Base UI, and the selected item shows a ✓ in the popup.
/// String values only — numeric call sites convert at the boundary.
export function AppSelect({
  value,
  onValueChange,
  options,
  className,
  popupClassName,
  disabled,
  ariaLabel,
  placeholder,
}: AppSelectProps) {
  return (
    <Select.Root
      value={value}
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      disabled={disabled ?? false}
      onValueChange={(v) => {
        if (typeof v === "string") onValueChange(v);
      }}
    >
      <Select.Trigger
        className={cn("app-select", className)}
        aria-label={ariaLabel}
      >
        <Select.Value placeholder={placeholder} />
        <span className="menu-chevron" aria-hidden="true">
          <AppIcon icon={ChevronDownIcon} size="caption" />
        </span>
      </Select.Trigger>
      <Select.Portal>
        {/* alignItemWithTrigger=false: drop below the trigger like the
            menubar dropdowns (and native Windows selects) instead of
            overlaying the trigger mac-style. */}
        <AppSelectPositioner
          align="start"
          sideOffset={4}
          alignItemWithTrigger={false}
          className="app-popup-positioner"
        >
          <Select.Popup className={cn("app-menu-list", "app-select-popup", popupClassName)}>
            {options.map((o) => (
              <Select.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled ?? false}
                className="app-menu-item"
              >
                <span className="app-menu-item-check" aria-hidden="true">
                  <Select.ItemIndicator>
                    <AppIcon icon={CheckIcon} size="body" />
                  </Select.ItemIndicator>
                </span>
                <Select.ItemText className="app-menu-item-label">
                  {o.label}
                </Select.ItemText>
                {o.detail}
              </Select.Item>
            ))}
          </Select.Popup>
        </AppSelectPositioner>
      </Select.Portal>
    </Select.Root>
  );
}
