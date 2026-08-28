import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

/// Actions on one Group row of the media pool, in the same virtual-anchor Base
/// UI menu the media cards use: right-click coordinates place it, Base UI owns
/// outside-click, Escape, arrow navigation and typeahead.
///
/// `Delete` is offered greyed with its reason rather than hidden: a referenced
/// composition is refused by `compositions_delete` (`CompositionInUse`), and a
/// row that silently lacks the action leaves the user with no way to learn why
/// (docs/features.md's prevention-over-refusal rule).
export function GroupPoolContextMenu({
  x,
  y,
  name,
  canDelete,
  onClose,
  onOpen,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  name: string;
  canDelete: boolean;
  onClose: () => void;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x,
        y,
        top: y,
        left: x,
        right: x,
        bottom: y,
        width: 0,
        height: 0,
      }),
    }),
    [x, y],
  );

  return (
    <MenuPrimitive.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={0}
          className="app-popup-positioner"
        >
          <MenuPrimitive.Popup
            className="app-menu-list media-context-menu"
            aria-label={t("media_pool.groups_actions_for", { label: name })}
          >
            <MenuPrimitive.Item className="app-menu-item" onClick={onOpen}>
              <MenuItemContent>{t("timeline.open_group")}</MenuItemContent>
            </MenuPrimitive.Item>
            <MenuPrimitive.Item className="app-menu-item" onClick={onRename}>
              <MenuItemContent>{t("timeline.rename_group")}</MenuItemContent>
            </MenuPrimitive.Item>
            <MenuPrimitive.Separator className="menu-separator" />
            <MenuPrimitive.Item
              className="app-menu-item media-context-menu-remove"
              disabled={!canDelete}
              title={
                canDelete
                  ? t("media_pool.groups_delete_hint")
                  : t("media_pool.groups_delete_in_use")
              }
              onClick={onDelete}
            >
              <MenuItemContent>{t("media_pool.groups_delete")}</MenuItemContent>
            </MenuPrimitive.Item>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

/// The leading check slot every `app-menu-item` reserves, so rows in this menu
/// line up with rows in the checkable ones.
function MenuItemContent({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span className="app-menu-item-check" aria-hidden="true" />
      <span className="app-menu-item-label">{children}</span>
    </>
  );
}
