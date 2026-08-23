import { useTranslation } from "react-i18next";

import { getCommand } from "../commands/registry";
import { MenuItem } from "./Menu";

/// One registry-driven row for a CONTEXT menu, the counterpart of
/// `CommandMenu.tsx`'s `CommandMenuItem` for the menu bar. Same payoff: label,
/// handler, enabled/checked state and the accelerator hint all come from the
/// one catalog the palette and the strip read, so a right-click row can never
/// drift from the key that does the same thing.
///
/// Two differences from the menu-bar item, both deliberate:
///
/// - `id` is a plain string, not `MenuCommandId`. The menu bar's ids are
///   type-locked to `ActionId | MenuOnlyCommandId` because `menuSpec.ts` is a
///   static book `tsc` can check; a context menu's rows include
///   self-contained commands outside that union, and the equivalent safety net
///   is a test that sweeps the exported id list (the `quickActions.test.ts`
///   pattern). Every call site must export its ids for that sweep.
/// - It renders `MenuItem` from `Menu.tsx` rather than a bare
///   `MenuPrimitive.Item`, which is what buys the check glyph, the
///   right-aligned accelerator and the disabled styling. `MenuItem` is only a
///   styled `MenuPrimitive.Item`, so it composes inside a context-menu popup
///   exactly as it does inside a dropdown.
export function CommandContextItem({
  id,
  onRun,
}: {
  id: string;
  /// Fires before the command, for the menu to close itself. Base UI closes on
  /// activation anyway, but the menus here own their own open state.
  onRun?: () => void;
}) {
  const { t } = useTranslation();
  const command = getCommand(id);
  // Not registered — a provider that hasn't mounted, or an id that no longer
  // exists. Omit the row rather than render a dead label, the same policy the
  // menu bar and the Quick Actions strip apply.
  if (!command) return null;
  return (
    <MenuItem
      label={t(command.labelKey)}
      // Evaluated here, in the row's own render: Base UI mounts the popup on
      // open, so every open re-reads the predicates.
      disabled={command.enabled ? !command.enabled() : false}
      {...(command.checked ? { checked: command.checked() } : {})}
      {...(command.actionId ? { actionId: command.actionId } : {})}
      onSelect={() => {
        onRun?.();
        return command.run();
      }}
    />
  );
}
