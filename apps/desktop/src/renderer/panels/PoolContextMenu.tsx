import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CircleDotIcon, CircleIcon } from "lucide-react";

import { MenuHeading, MenuItem, MenuSeparator } from "../menu/Menu";
import { useCursorAnchor } from "../timeline/contextMenuAnchor";
import type { MediaSummary } from "../ipc";
import type { GroupPoolItem } from "./poolItems";

export type MediaProxyMode = "auto" | "proxy" | "original";

const PROXY_MODES: readonly MediaProxyMode[] = ["auto", "proxy", "original"];

/// The card one right-click acts on, carrying that kind's own actions.
///
/// The two item lists intersect in nothing — proxy settings are meaningless on
/// a Group, and a Group's `open` has no media equivalent — so the kinds keep
/// separate handlers instead of the menu taking the union of every callback
/// either might need. Media deliberately do not gain rename: `MediaSummary`
/// has no label writer, and giving it one is a command, a history entry and a
/// search-index path.
export type PoolMenuTarget = MediaMenuTarget | GroupMenuTarget;

interface MediaMenuTarget {
  kind: "media";
  media: MediaSummary;
  /// Null on a source that bypasses proxies; the heading and the radio group
  /// both go with it, leaving the menu its commands alone.
  proxyMode: MediaProxyMode | null;
  canSetProxy: boolean;
  canAnalyze: boolean;
  analyzing: boolean;
  canRemove: boolean;
  onProxyModeChange: (mode: MediaProxyMode) => void;
  onAnalyze: () => void;
  onRemove: () => void;
}

interface GroupMenuTarget {
  kind: "group";
  item: GroupPoolItem;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/// The media pool's right-click menu, for either kind of card.
///
/// Owns the shell the kinds share: the cursor-anchored Base UI popup, the
/// accessible name and the scroll dismissal. Owns none of the actions — they
/// ride on `target`, and the rows dispatch on its kind.
///
/// One menu is one open state in the Panel, so opening either kind closes the
/// other by construction rather than by a guard.
export function PoolContextMenu({
  x,
  y,
  target,
  onClose,
}: {
  x: number;
  y: number;
  target: PoolMenuTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  // The coordinates are viewport-fixed, so any ancestor scroll leaves the menu
  // floating detached from the card it belongs to. Close instead.
  useEffect(() => {
    window.addEventListener("scroll", onClose, true);
    return () => window.removeEventListener("scroll", onClose, true);
  }, [onClose]);

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
            aria-label={
              target.kind === "media"
                ? t("media_pool.actions_for", { label: target.media.label })
                : t("media_pool.groups_actions_for", {
                    label: target.item.name,
                  })
            }
          >
            {target.kind === "media" ? (
              <MediaItems target={target} />
            ) : (
              <GroupItems target={target} />
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

/// Add future per-media commands here rather than putting controls back on the
/// cards — the card chrome is deliberately action-free.
function MediaItems({ target }: { target: MediaMenuTarget }) {
  const { t } = useTranslation();
  return (
    <>
      {target.proxyMode !== null && (
        <>
          <MenuHeading label={t("media_pool.proxy_heading")} />
          <MenuPrimitive.RadioGroup
            className="media-proxy-radio-group"
            value={target.proxyMode}
            disabled={!target.canSetProxy}
            onValueChange={(value) =>
              target.onProxyModeChange(value as MediaProxyMode)
            }
          >
            {PROXY_MODES.map((mode) => (
              <MenuPrimitive.RadioItem
                key={mode}
                value={mode}
                closeOnClick
                className="media-proxy-radio-button"
                title={t(`media_pool.proxy_mode_${mode}_hint`)}
              >
                <MenuPrimitive.RadioItemIndicator
                  keepMounted
                  className="media-proxy-radio-indicator"
                  render={(props, state) => {
                    const Icon = state.checked ? CircleDotIcon : CircleIcon;
                    return (
                      <span {...props}>
                        <Icon size={10} aria-hidden />
                      </span>
                    );
                  }}
                />
                <span className="media-proxy-radio-label">
                  {t(`media_pool.proxy_mode_${mode}`)}
                </span>
              </MenuPrimitive.RadioItem>
            ))}
          </MenuPrimitive.RadioGroup>
          <MenuSeparator />
        </>
      )}

      {target.media.kind === "Video" && (
        <>
          <MenuItem
            label={
              target.analyzing
                ? t("media_pool.analyze_shots_running")
                : t("media_pool.analyze_shots")
            }
            hint={t("media_pool.analyze_shots_hint")}
            disabled={!target.canAnalyze || target.analyzing}
            onSelect={target.onAnalyze}
          />
          <MenuSeparator />
        </>
      )}

      {/* Greyed with its reason rather than hidden while the import is still
          running: a row that silently vanishes teaches the user nothing
          (docs/features.md's prevention-over-refusal rule). */}
      <MenuItem
        className="media-context-menu-remove"
        label={t("media_pool.remove_menu")}
        hint={
          target.canRemove
            ? t("media_pool.remove_menu")
            : t("media_pool.remove_wait_for_import")
        }
        disabled={!target.canRemove}
        onSelect={target.onRemove}
      />
    </>
  );
}

/// `Delete` is offered greyed with its reason rather than hidden: a referenced
/// composition is refused by `compositions_delete` (`CompositionInUse`), and a
/// row that silently lacks the action leaves the user with no way to learn why
/// (docs/features.md's prevention-over-refusal rule).
function GroupItems({ target }: { target: GroupMenuTarget }) {
  const { t } = useTranslation();
  const canDelete = target.item.refCount === 0;
  return (
    <>
      <MenuItem label={t("timeline.open_group")} onSelect={target.onOpen} />
      <MenuItem label={t("timeline.rename_group")} onSelect={target.onRename} />
      <MenuSeparator />
      <MenuItem
        className="media-context-menu-remove"
        label={t("media_pool.groups_delete")}
        hint={
          canDelete
            ? t("media_pool.groups_delete_hint")
            : t("media_pool.groups_delete_in_use")
        }
        disabled={!canDelete}
        onSelect={target.onDelete}
      />
    </>
  );
}
