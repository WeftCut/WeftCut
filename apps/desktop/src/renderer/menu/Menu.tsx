import type { ReactNode } from "react";
import { Menubar } from "@base-ui/react/menubar";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import {
  resolveAccelerator,
} from "../shortcuts/match";
import { useEffectiveBindings } from "../shortcuts/bindings-context";
import type { ActionId } from "../shortcuts/defs";

/// The menu bar container. Base UI's Menubar makes the triggers one
/// composite roving-focus stop and coordinates the Menus inside it:
/// click opens, hovering an adjacent trigger while any menu is open
/// switches to it, ArrowLeft/Right move between menus, and opening one
/// menu closes the previous (only one dropdown open at a time).
export function MenuBar({ children }: { children: ReactNode }) {
  return <Menubar className="menu-bar">{children}</Menubar>;
}

interface MenuProps {
  /// Top-level label rendered on the trigger button.
  label: string;
  /// Tooltip on the trigger.
  hint?: string;
  /// `MenuItem` / `MenuSeparator` / `MenuHeading` children.
  children: ReactNode;
}

/// One dropdown in the bar. Base UI supplies portal + Floating UI positioning, outside-click and
/// Escape close, ArrowDown/Up item navigation, and typeahead. The
/// .menu-* classes carry the visual identity; placement is via the
/// Positioner (align start, 4px below the trigger).
export function Menu({ label, hint, children }: MenuProps) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger className="menu-trigger" title={hint}>
        <span className="menu-trigger-label">{label}</span>
        <span className="menu-chevron" aria-hidden="true">
          <ChevronDownIcon size={11} />
        </span>
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          align="start"
          sideOffset={4}
          className="app-popup-positioner"
        >
          <MenuPrimitive.Popup className="app-menu-list">
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

interface MenuItemProps {
  label: string;
  hint?: string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  /// Renders a check glyph; useful for radio-style preset rows.
  checked?: boolean;
  /// When set, the item renders that action's accelerator right-aligned.
  /// Display-only — the handler still comes from `onSelect`.
  actionId?: ActionId;
  /// Extra class beside `app-menu-item`, for a row whose own menu dresses it —
  /// the destructive rows of the media pool's menu are the case. Not a place
  /// to re-style the shared row.
  className?: string;
}

export function MenuItem({
  label,
  hint,
  onSelect,
  disabled,
  checked,
  actionId,
  className,
}: MenuItemProps) {
  // Show only the *first* effective binding for the action. The menu
  // has no room for multi-binding lists; the Settings → Keyboard panel
  // is where the user goes to see them all. Reading through the
  // bindings context (rather than `ACTION_DEFS.defaultKeys`) means a
  // user remap shows up here immediately — the label and the bound
  // key cannot drift.
  const effective = useEffectiveBindings(actionId);
  const accelerator = effective ? resolveAccelerator(effective) : "";
  return (
    <MenuPrimitive.Item
      className={className ? `app-menu-item ${className}` : "app-menu-item"}
      title={hint}
      disabled={disabled ?? false}
      // Base UI closes the menu on activation before this runs, so an
      // async handler that throws can't keep the dropdown open.
      // Promise rejections are the caller's responsibility.
      onClick={() => void onSelect()}
    >
      <span className="app-menu-item-check" aria-hidden="true">
        {checked ? <CheckIcon size={12} /> : null}
      </span>
      <span className="app-menu-item-label">{label}</span>
      {accelerator && (
        <span className="app-menu-item-accelerator" aria-hidden="true">
          {accelerator}
        </span>
      )}
    </MenuPrimitive.Item>
  );
}

/// The `onOpenChange` a menu that forces `open` and unmounts itself on close
/// must use — every context menu here, since each is rendered by its owner only
/// while it should be on screen.
///
/// LANDMINE: opening one of our own `SubMenu`s reports `sibling-open` to the
/// PARENT Root. Treating that as a dismissal unmounts the tree in the same
/// frame the submenu mounts, so the submenu flashes once, the whole menu
/// vanishes, and focus is returned to the page. A menubar `Menu` never shows
/// this because its Root is uncontrolled and owns its own open state.
export function closeContextMenuOn(
  onClose: () => void,
): (open: boolean, details: { reason: string }) => void {
  return (open, details) => {
    if (!open && details.reason !== "sibling-open") onClose();
  };
}

/// Set by `handCaretToEditor`, read and cleared by `contextMenuFinalFocus`.
/// Module-level because the two run in the same tick — a row's handler and the
/// unmount it causes — and never overlap between menus.
let caretHandedOff = false;

/// Call from a context-menu row whose handler opens an INLINE EDITOR: a rename
/// field that lives in the page, not a dialog. It tells the menu the caret has
/// a new owner, so `contextMenuFinalFocus` can leave it alone.
export function handCaretToEditor(): void {
  caretHandedOff = true;
}

/// The `finalFocus` every context menu with such a row must pass to its Popup.
///
/// LANDMINE: Base UI returns focus to whatever held it before the menu opened,
/// and queues that as a microtask while the popup unmounts — which lands AFTER
/// the row's handler has put the caret in the field it opened. Those fields
/// commit on blur, so the returned focus closes the editor in the frame it
/// appeared and the row reads as doing nothing at all.
///
/// It cannot be a prop closed over the owner's state: Base UI reads `finalFocus`
/// from a ref during the unmount, and that ref stopped updating at the last
/// render BEFORE the row ran. Hence the latch, set synchronously by the row.
///
/// Every other close still returns focus, which is what keeps the keyboard on
/// the region the menu was opened from (ADR 0041).
export function contextMenuFinalFocus(): boolean {
  const handedOff = caretHandedOff;
  caretHandedOff = false;
  return !handedOff;
}

interface SubMenuProps {
  /// Label rendered on the trigger row.
  label: string;
  disabled?: boolean;
  /// `MenuItem` / `MenuSeparator` / `MenuHeading` children.
  children: ReactNode;
}

/// A nested dropdown inside a Menu. Base UI's SubmenuRoot supplies hover
/// intent, ArrowRight/Left open/close, and Escape handling; nested inside a
/// Menu its Positioner defaults to side=inline-end/align=start, so the popup
/// opens to the trigger's right edge with no extra placement props. The
/// trigger row reuses the .app-menu-item styles (plus a right chevron) so it
/// lines up with plain items.
///
/// LANDMINE: a CONTEXT menu holding one of these must set
/// `highlightItemOnHover={false}` on its Root, or the submenu is unreachable —
/// it opens on hover and then closes the instant the pointer travels toward it.
/// The chain, traced live: hover-highlight is Base UI's roving DOM FOCUS, so
/// the trigger row holds focus; leaving that row fires `useListNavigation`'s
/// `onPointerLeave`, which refocuses the parent popup; the submenu sees focus
/// leave its trigger and dismisses itself with reason `focus-out`. The pointer
/// crosses the parent's edge one pixel before it reaches the submenu, so the
/// close always wins the race.
///
/// A menubar Menu does NOT need this and must not get it — only these detached
/// `Menu.Root open` context menus reproduce it, which is why the fix is per-Root
/// rather than built in here. The rows keep their hover feedback through
/// `.app-menu-item:hover` in `styles/menu.css`; what is given up is hover
/// setting the ARMED row, so Enter still acts on the arrow-key row, not the
/// hovered one. On a menu opened by right-click that is the right trade.
export function SubMenu({ label, disabled, children }: SubMenuProps) {
  return (
    <MenuPrimitive.SubmenuRoot>
      <MenuPrimitive.SubmenuTrigger
        className="app-menu-item app-submenu-trigger"
        disabled={disabled ?? false}
      >
        {/* Empty check-column spacer so the label aligns with MenuItem rows. */}
        <span className="app-menu-item-check" aria-hidden="true" />
        <span className="app-menu-item-label">{label}</span>
        <span className="app-submenu-chevron" aria-hidden="true">
          <ChevronRightIcon size={12} />
        </span>
      </MenuPrimitive.SubmenuTrigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner className="app-popup-positioner">
          <MenuPrimitive.Popup className="app-menu-list">
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.SubmenuRoot>
  );
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="menu-separator" />;
}

export function MenuHeading({ label }: { label: string }) {
  return (
    <div className="menu-heading" role="presentation">
      {label}
    </div>
  );
}
