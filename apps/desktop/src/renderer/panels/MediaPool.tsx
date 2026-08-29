import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  FilterIcon,
  FolderInputIcon,
  Group as GroupIcon,
  LayoutGridIcon,
  ListIcon,
  RectangleHorizontalIcon,
} from "lucide-react";

import {
  PoolContextMenu,
  type MediaProxyMode,
  type PoolMenuTarget,
} from "./PoolContextMenu";
import { MediaThumbnail } from "./MediaThumbnail";
import { mediaReadiness, type ProxyState } from "./mediaReadiness";
import { isOptimizing, type OptimizeInfo } from "./importOptimize";
import { RenameGroupDialog } from "./RenameGroupDialog";
import {
  filterPoolItems,
  filterUnusedPoolItems,
  poolCollator,
  poolItems,
  type GroupPoolItem,
} from "./poolItems";
import {
  mediaReferenceMeta,
  mediaReferencesFor,
  type MediaReference,
} from "./mediaReferences";
import {
  MEDIA_DRAG_TYPE,
  compositionDragPayload,
  hideNativeDragPreview,
  mediaDragPayload,
  poolDragVisual,
  useMediaDragStore,
} from "../timeline/mediaDrag";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { Button } from "../components/ui/button";
import {
  type MediaPoolLayout,
  type MediaSummary,
  type ProjectSummary,
  compositionsDelete,
  generateQuickProxy,
  analyzeShots,
  removeMedia,
} from "../ipc";
import { formatMediaDuration } from "../frames";
import { parseCommandError } from "../errors/parseCommandError";
import { registerRevealMedia } from "../state/navigation";
import { tryMutate } from "../errors/tryMutate";
import { useProxyPrefStore, setProxyOverride } from "../state/proxyPreferenceStore";
import { setAppSettings, useMediaPoolLayout } from "../settings/appSettingsStore";
import { openComposition } from "../state/compositionAnchorStore";
import {
  useCompositionRefCounts,
  useGroupCount,
  useGroupOrdinals,
  useMediaRefCounts,
  useProjectSummary,
} from "../state/projectStore";
import {
  setCompositionSelection,
  setMediaSelection,
  useSelectedCompositionId,
  useSelectedMediaId,
} from "../state/selectionStore";
import { quickProxyPath } from "../render/decodeRoute";

function isFileDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

/// Card arrangement options for the pool, persisted app-wide as
/// app_settings.media_pool_layout. `large` is the legacy one-card-per-row
/// layout; `grid` packs fixed-size cards into as many columns as fit;
/// `list` renders compact file-manager-style rows.
const LAYOUT_MODES: ReadonlyArray<{
  mode: MediaPoolLayout;
  Icon: typeof ListIcon;
}> = [
  { mode: "large", Icon: RectangleHorizontalIcon },
  { mode: "grid", Icon: LayoutGridIcon },
  { mode: "list", Icon: ListIcon },
];

interface MediaRemovalTarget {
  media: MediaSummary;
  references: MediaReference[];
}

/// The card whose context menu is open, with the viewport point that anchors
/// it. Both kinds share the one state, so opening either closes the other with
/// no guard to forget.
///
/// A media card travels as an id — its row is re-read from the `media` prop, so
/// an import that finishes under an open menu re-renders the rows it gates. A
/// Group's item travels whole: the menu's label and its Delete gate are the
/// card's own fields, and re-deriving them would be a second list walk per open.
interface PoolMenuAnchor {
  x: number;
  y: number;
  target:
    | { kind: "media"; mediaId: string }
    | { kind: "group"; item: GroupPoolItem };
}

/// `MediaInUse` refusal → the authoritative referencing-layer ids, via the
/// shared IPC-rejection parser. Null when the failure is anything else.
function parseMediaInUseLayerIds(error: unknown): string[] | null {
  const parsed = parseCommandError(error);
  if (parsed?.error !== "MediaInUse") return null;
  return Array.isArray(parsed.referenced_by)
    ? parsed.referenced_by.filter((id): id is string => typeof id === "string")
    : [];
}

function MediaDragPreview() {
  const active = useMediaDragStore((s) => s.active);
  const visual = useMediaDragStore((s) => s.visual);
  const absorptionTarget = useMediaDragStore((s) => s.absorptionTarget);
  const moveVisual = useMediaDragStore((s) => s.moveVisual);

  useEffect(() => {
    const followPointer = (e: DragEvent) => {
      // Chromium uses (0, 0) as an unavailable-coordinate sentinel for some
      // drag events. Keeping the last real point avoids a jump to the corner.
      if (e.clientX === 0 && e.clientY === 0) return;
      moveVisual(e.clientX, e.clientY);
    };
    window.addEventListener("drag", followPointer, true);
    window.addEventListener("dragover", followPointer, true);
    return () => {
      window.removeEventListener("drag", followPointer, true);
      window.removeEventListener("dragover", followPointer, true);
    };
  }, [moveVisual]);

  if (active === null || visual === null) return null;

  const absorbing = absorptionTarget !== null;
  const left = absorbing
    ? absorptionTarget.left
    : visual.clientX - visual.pointerOffsetX;
  const top = absorbing
    ? absorptionTarget.top
    : visual.clientY - visual.pointerOffsetY;
  const width = absorbing ? absorptionTarget.width : visual.width;
  const height = absorbing ? absorptionTarget.height : visual.height;

  return createPortal(
    <div
      data-testid="media-drag-preview"
      className={`media-drag-preview${absorbing ? " is-absorbing" : ""}`}
      style={{
        width,
        height,
        transform: `translate3d(${left}px, ${top}px, 0)`,
      }}
      aria-hidden="true"
    >
      <div className="media-drag-preview-thumb">
        {/* A composition has no frame to show until it is staged, so the Group
            clip's own glyph stands where a media thumbnail stands. */}
        {active.source === "media" ? (
          <MediaThumbnail mediaId={active.mediaId} mediaKind={active.kind} />
        ) : (
          <GroupIcon size={16} aria-hidden />
        )}
      </div>
      <span className="media-drag-preview-name">{active.label}</span>
    </div>,
    document.body,
  );
}

/// The media-pool column doubles as the drop target for Explorer file
/// drags. HTML5 drag events fire because the OS-level drop interception is
/// off so the timeline's internal HTML5 drag-and-drop remains available;
/// the dropped Files' real filesystem paths are resolved by the preload's
/// `wireFileDrop` listener, not here (see `onDrop` below).
/// Internal media-item drags carry a custom MIME type, not "Files", and are
/// ignored here.
export function MediaDropZone({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  // dragenter/leave fire per descendant; track depth so the highlight
  // doesn't flicker while moving across children.
  const depth = useRef(0);
  return (
    <section
      className="media-pool"
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        depth.current += 1;
        setActive(true);
      }}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return;
        depth.current -= 1;
        if (depth.current <= 0) {
          depth.current = 0;
          setActive(false);
        }
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        depth.current = 0;
        setActive(false);
        // Path resolution + import are handled in the preload's own `wireFileDrop`
        // window-level drop listener: there the dropped File objects are still
        // native-backed so `webUtils.getPathForFile` returns the real path (across
        // the contextBridge it returns '' — electron#44600). This handler only
        // clears the drop-highlight; it intentionally does no path work.
      }}
    >
      {children}
      {active && (
        <div className="media-pool-drop-overlay" aria-hidden="true">
          {t("media_pool.drop_to_import")}
        </div>
      )}
    </section>
  );
}

export function MediaPool({
  media,
  importing,
  proxyState,
  previewDecodable,
  optimizeById,
  fpsNum,
  fpsDen,
  onCancelImport,
  onMutated,
  onImportMedia,
}: {
  media: MediaSummary[];
  importing: ReadonlySet<string>;
  proxyState: ReadonlyMap<string, ProxyState>;
  previewDecodable: ReadonlySet<string>;
  /// Pool-wide optimization verdicts from useImportReadiness. Drives the
  /// background-optimizing dot and the codec-named reason in badge tooltips.
  optimizeById?: ReadonlyMap<string, OptimizeInfo>;
  fpsNum: number;
  fpsDen: number;
  onCancelImport: (mediaId: string) => Promise<void>;
  onMutated: () => Promise<void>;
  onImportMedia: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const layout = useMediaPoolLayout();
  // Groups live on the whole composition set, not on the media list this Panel
  // is handed — so the count that decides whether the pool is truly empty comes
  // from the store, and so does the other half of the list below.
  const groupCount = useGroupCount();
  const summary = useProjectSummary();
  const ordinals = useGroupOrdinals();
  const refCounts = useCompositionRefCounts();
  const mediaRefCounts = useMediaRefCounts();
  // Deliberately NOT `app_settings`: the layout switch beside it is appearance
  // and persists, but a filter that HIDES things and survives a restart is how
  // a user concludes their media is gone. Session-scoped, like `query`.
  const [unusedOnly, setUnusedOnly] = useState(false);
  const selectedMediaId = useSelectedMediaId();
  const beginMediaDrag = useMediaDragStore((s) => s.begin);
  const endMediaDrag = useMediaDragStore((s) => s.end);
  const proxyOverrides = useProxyPrefStore((s) => s.overrides);

  // Palette "reveal in media pool": clear EVERY filter, then flash + scroll the
  // row into view. Both of them, not just the query: revealing a USED item with
  // "show only unused" on would scroll to a card that is not rendered.
  const [flashId, setFlashId] = useState<string | null>(null);
  // The media id whose shot analysis is currently running. One at a time is
  // enough for a pool action; reopening its menu shows the pending label and
  // disables a second kick.
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<PoolMenuAnchor | null>(null);
  // Stable, so the menu's scroll-dismissal listener is registered once per open
  // rather than re-bound by every re-render underneath it.
  const closeMenu = useCallback(() => setMenu(null), []);
  const [renaming, setRenaming] = useState<GroupPoolItem | null>(null);
  const [removalTarget, setRemovalTarget] =
    useState<MediaRemovalTarget | null>(null);
  useEffect(
    () =>
      registerRevealMedia((id) => {
        setQuery("");
        setUnusedOnly(false);
        setFlashId(id);
      }),
    [],
  );
  useEffect(() => {
    if (flashId === null) return;
    // Reveal can reopen or activate this dock Panel. Defer until Dockview has
    // settled the new group geometry so scrollIntoView uses the final bounds.
    const scrollTimer = setTimeout(() => {
      document
        .querySelector(`[data-media-id="${CSS.escape(flashId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, 200);
    const timer = setTimeout(() => setFlashId(null), 1600);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(timer);
    };
  }, [flashId]);

  const collator = useMemo(() => poolCollator(i18n.language), [i18n.language]);
  const items = useMemo(
    () => poolItems(media, summary, ordinals, refCounts, t, collator),
    [media, summary, ordinals, refCounts, t, collator],
  );
  // Unused first, then the query: the placeholder below has to tell "nothing
  // here is unused" from "nothing matches", and only the intermediate list
  // distinguishes them.
  const unused = useMemo(
    () => (unusedOnly ? filterUnusedPoolItems(items, mediaRefCounts) : items),
    [items, unusedOnly, mediaRefCounts],
  );
  const visible = useMemo(() => filterPoolItems(unused, query), [unused, query]);

  if (media.length === 0 && groupCount === 0) {
    return (
      <div className="media-pool-inner media-pool-inner--empty">
        <p className="placeholder">{t("media_pool.empty")}</p>
        {/* Empty-state CTA: the same import action as the menu, made the
            obvious next step when the pool has nothing yet. */}
        <Button
          variant="default"
          size="lg"
          onClick={() => void onImportMedia()}
        >
          <FolderInputIcon size={14} aria-hidden />
          {t("actions.import_media")}
        </Button>
      </div>
    );
  }

  // Trimmed so trailing whitespace from a paste doesn't kill all matches, and
  // so the no-matches line quotes what the user meant to type.
  const trimmed = query.trim();
  const mediaTarget = menu?.target.kind === "media" ? menu.target : null;
  const groupTarget = menu?.target.kind === "group" ? menu.target : null;
  const menuCardId = mediaTarget?.mediaId ?? groupTarget?.item.id;
  const contextMedia = mediaTarget
    ? (media.find((candidate) => candidate.id === mediaTarget.mediaId) ?? null)
    : null;
  const contextReadiness = contextMedia
    ? mediaReadiness(contextMedia, importing, proxyState, {
        previewDecodable: previewDecodable.has(contextMedia.id),
      })
    : null;
  const contextReason =
    contextReadiness && !contextReadiness.ready
      ? contextReadiness.reason
      : null;
  const contextOverride = contextMedia
    ? proxyOverrides[contextMedia.id]
    : undefined;
  const contextProxyMode: MediaProxyMode | null =
    !contextMedia || contextMedia.decode_route.route === "bypass"
      ? null
      : contextOverride === undefined
        ? "auto"
        : contextOverride
          ? "proxy"
          : "original";

  // The open menu's subject and the actions its kind offers. Null while a media
  // row is resolving to nothing — the item left the pool under the open menu —
  // which takes the menu down with it.
  let menuTarget: PoolMenuTarget | null = null;
  if (groupTarget) {
    const item = groupTarget.item;
    menuTarget = {
      kind: "group",
      item,
      onOpen: () => {
        closeMenu();
        openComposition(item.id, null);
      },
      onRename: () => {
        closeMenu();
        setRenaming(item);
      },
      onDelete: () => {
        closeMenu();
        void tryMutate(
          () => compositionsDelete(item.id),
          "compositions_delete",
        ).then((ok) => (ok ? onMutated() : undefined));
      },
    };
  } else if (contextMedia && contextReadiness) {
    const m = contextMedia;
    menuTarget = {
      kind: "media",
      media: m,
      proxyMode: contextProxyMode,
      canSetProxy: contextReason !== "importing",
      canAnalyze: contextReadiness.ready,
      analyzing: analyzingId === m.id,
      canRemove: contextReason !== "importing",
      onProxyModeChange: (mode) => {
        closeMenu();
        const next = mode === "auto" ? null : mode === "proxy" ? true : false;
        if (next === true && quickProxyPath(m) === null) {
          void generateQuickProxy(m.id);
        }
        // Persisted project-settings write: a rejection without this wrap
        // is an unhandled promise rejection, not even a devtools warning.
        void tryMutate(() => setProxyOverride(m.id, next), "Set proxy mode");
      },
      onAnalyze: () => {
        closeMenu();
        setAnalyzingId(m.id);
        void analyzeShots(m.id)
          .catch((error) => {
            console.warn("analyze shots failed:", error);
          })
          .finally(() =>
            setAnalyzingId((current) => (current === m.id ? null : current)),
          );
      },
      onRemove: () => {
        closeMenu();
        setRemovalTarget({
          media: m,
          references: mediaReferencesFor(m.id, summary, ordinals, t),
        });
      },
    };
  }

  return (
    <>
      <MediaDragPreview />
      {menu && menuTarget && (
        <PoolContextMenu
          // Card AND point: reopening on the same card at a new place has to
          // remount, or the popup keeps the position it first mounted at.
          key={`${menuCardId}:${menu.x}:${menu.y}`}
          x={menu.x}
          y={menu.y}
          target={menuTarget}
          onClose={closeMenu}
        />
      )}
      {renaming && (
        <RenameGroupDialog
          key={renaming.id}
          compositionId={renaming.id}
          displayName={renaming.name}
          storedLabel={summary?.compositions[renaming.id]?.label ?? null}
          onClose={() => setRenaming(null)}
          onMutated={onMutated}
        />
      )}
      {removalTarget && (
        <RemoveMediaDialog
          key={removalTarget.media.id}
          target={removalTarget}
          summary={summary}
          ordinals={ordinals}
          fpsNum={fpsNum}
          fpsDen={fpsDen}
          onReferencesChanged={(references) =>
            setRemovalTarget((current) =>
              current ? { ...current, references } : null,
            )
          }
          onClose={() => setRemovalTarget(null)}
          onRemoved={onMutated}
        />
      )}
      <div className="media-pool-search">
        {/* Same import action as the menu bar's Import (Mod+I), surfaced at
            the pool's leading edge so it's reachable without the menu. */}
        <button
          type="button"
          className="media-import-button"
          title={t("actions.import_media")}
          aria-label={t("actions.import_media")}
          onClick={() => void onImportMedia()}
        >
          <FolderInputIcon size={14} aria-hidden />
        </button>
        <AppInput
          type="search"
          clearable
          clearAriaLabel={t("media_pool.clear_search")}
          placeholder={t("media_pool.search_placeholder")}
          ariaLabel={t("media_pool.search_placeholder")}
          value={query}
          onValueChange={setQuery}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query !== "") {
              e.preventDefault();
              setQuery("");
            }
          }}
        />
        {/* The Groups section gathered orphans under a heading; the merged
            list scatters them by name, and this toggle is what buys that job
            back — the surface ADR 0042 requires a remnant to stay removable
            through. */}
        <button
          type="button"
          className={`media-filter-button${unusedOnly ? " is-active" : ""}`}
          aria-pressed={unusedOnly}
          title={t("media_pool.unused_filter")}
          aria-label={t("media_pool.unused_filter")}
          onClick={() => setUnusedOnly((on) => !on)}
        >
          <FilterIcon size={14} aria-hidden />
        </button>
        <div
          className="media-layout-switch"
          role="group"
          aria-label={t("media_pool.layout_label")}
        >
          {LAYOUT_MODES.map(({ mode, Icon }) => (
            <button
              key={mode}
              type="button"
              className={`media-layout-button${layout === mode ? " is-active" : ""}`}
              aria-pressed={layout === mode}
              title={t(`media_pool.layout_${mode}`)}
              onClick={() => void setAppSettings({ media_pool_layout: mode })}
            >
              <Icon size={14} aria-hidden />
            </button>
          ))}
        </div>
      </div>
      <div className="media-pool-inner">
        {visible.length === 0 ? (
          <p className="placeholder">
            {/* Both kinds decide the first: a project holding only Groups is
                not an empty pool, whatever the media prop says. The filter's
                own dead end earns the third — a pool whose every item is in
                use must never answer that it holds nothing. */}
            {items.length === 0
              ? t("media_pool.empty")
              : unused.length === 0
                ? t("media_pool.no_unused")
                : t("media_pool.no_matches", { query: trimmed })}
          </p>
        ) : (
          <ul
            className={`media-list${layout !== "large" ? ` is-layout-${layout}` : ""}`}
          >
            {visible.map((item) => {
              if (item.kind === "group") {
                return (
                  <GroupPoolCard
                    key={item.id}
                    item={item}
                    layout={layout}
                    onMenu={(at) =>
                      setMenu(
                        at ? { ...at, target: { kind: "group", item } } : null,
                      )
                    }
                  />
                );
              }
              const m = item.media;
              const readiness = mediaReadiness(m, importing, proxyState, {
                previewDecodable: previewDecodable.has(m.id),
              });
              const interactive = readiness.ready;
              const reason = readiness.ready ? null : readiness.reason;
              // Optimization is the second, orthogonal axis: `readiness`
              // answers "may the user drag this?", `optimize` answers "is a
              // background job still working on it?". The dot renders only on
              // the ready branch, so it can never stack on a blocking badge.
              const optimize = optimizeById?.get(m.id);
              const optimizeReasonText = optimize
                ? optimize.status === "checking"
                  ? t("import_proxy.checking_one")
                  : t(`import_proxy.${optimize.reason.key}`, {
                      codec: optimize.reason.codec,
                    })
                : null;
              const withReason = (hint: string) =>
                optimizeReasonText ? `${hint}\n${optimizeReasonText}` : hint;
              const showOptimizingDot =
                interactive && optimize != null && isOptimizing(optimize.status);
              // Selectable whatever the readiness: an import in flight and a
              // missing source are the two cases where reading the inspector's
              // description matters most.
              const selected = selectedMediaId === m.id;
              return (
                <li
                  key={m.id}
                  data-media-id={m.id}
                  className={[
                    "media-item",
                    // One disabled treatment, whatever withdrew the card — see
                    // `.media-item.is-not-placeable`. The reason classes below
                    // stay because each dresses its OWN badge.
                    interactive ? "" : "is-not-placeable",
                    reason === "importing" ? "is-importing" : "",
                    reason === "missing" ? "is-missing" : "",
                    reason === "proxy_pending" ? "is-proxy-pending" : "",
                    reason === "proxy_failed" ? "is-proxy-failed" : "",
                    flashId === m.id ? "is-search-flash" : "",
                    selected ? "is-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  draggable={interactive}
                  tabIndex={0}
                  aria-haspopup="menu"
                  aria-keyshortcuts="Shift+F10"
                  aria-selected={selected}
                  onClick={() => setMediaSelection(m.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Right-click selects, as it does on a Group card: the menu
                    // acts on this card, so the inspector must be describing it.
                    setMediaSelection(m.id);
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      target: { kind: "media", mediaId: m.id },
                    });
                  }}
                  // No Enter: a media item has nothing to open. The Group card's
                  // Enter enters its composition; media has no such destination,
                  // and the pool must not be where one gets invented.
                  onKeyDown={(e) => {
                    if (
                      e.key !== "ContextMenu" &&
                      !(e.shiftKey && e.key === "F10")
                    ) {
                      return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMediaSelection(m.id);
                    setMenu({
                      x: rect.left + Math.min(32, rect.width / 2),
                      y: rect.top + Math.min(32, rect.height / 2),
                      target: { kind: "media", mediaId: m.id },
                    });
                  }}
                  onDragStart={(e) => {
                    closeMenu();
                    const payload = mediaDragPayload(m);
                    beginMediaDrag(
                      payload,
                      poolDragVisual(e.currentTarget, e.clientX, e.clientY),
                    );
                    e.dataTransfer.setData(
                      MEDIA_DRAG_TYPE,
                      JSON.stringify(payload),
                    );
                    e.dataTransfer.effectAllowed = "copy";
                    hideNativeDragPreview(e.dataTransfer);
                  }}
                  onDragEnd={endMediaDrag}
                  title={
                    interactive
                      ? showOptimizingDot
                        ? withReason(t("media_pool.optimizing_hint"))
                        : t("media_pool.card_ready_hint")
                      : reason === "missing"
                        ? t("media_pool.missing_hint", { path: m.path })
                        : reason === "proxy_pending"
                          ? withReason(
                              t("media_pool.proxy_pending_hint", {
                                defaultValue: "Preview is being prepared…",
                              }),
                            )
                          : reason === "proxy_failed"
                            ? withReason(
                                t("media_pool.proxy_failed_hint", {
                                  defaultValue:
                                    "Preview could not be prepared. Re-import to retry.",
                                }),
                              )
                            : t("media_pool.importing")
                  }
                >
                  <div className="media-item-thumb">
                    <MediaThumbnail mediaId={m.id} mediaKind={m.kind} />
                    <span
                      className={`media-kind kind-${m.kind.toLowerCase()}`}
                    >
                      {t(`kinds.${m.kind.toLowerCase()}`, {
                        defaultValue: m.kind,
                      })}
                    </span>
                    <div className="media-item-metadata">
                      <span className="media-resolution-badge">
                        {m.width !== null && m.height !== null
                          ? `${m.width}×${m.height}`
                          : "—"}
                      </span>
                      <span className="media-duration-badge">
                        {m.duration_us !== null
                          ? formatMediaDuration(m.duration_us)
                          : t("media_pool.no_duration")}
                      </span>
                    </div>
                    {reason === "importing" && (
                      <button
                        type="button"
                        className="media-import-cancel"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await onCancelImport(m.id);
                        }}
                        title={t("media_pool.importing_cancel_hint")}
                      >
                        {t("media_pool.importing")}
                      </button>
                    )}
                    {reason === "missing" && (
                      <span
                        className="media-missing-badge"
                        title={t("media_pool.missing_hint", { path: m.path })}
                      >
                        {t("media_pool.missing")}
                      </span>
                    )}
                    {reason === "proxy_pending" && (
                      <span
                        className="media-proxy-pending-badge"
                        title={withReason(
                          t("media_pool.proxy_pending_hint", {
                            defaultValue: "Preview is being prepared…",
                          }),
                        )}
                      >
                        {t("media_pool.proxy_pending", {
                          defaultValue: "Preparing…",
                        })}
                      </span>
                    )}
                    {reason === "proxy_failed" && (
                      <span
                        className="media-proxy-failed-badge"
                        title={withReason(
                          t("media_pool.proxy_failed_hint", {
                            defaultValue:
                              "Preview could not be prepared. Re-import to retry.",
                          }),
                        )}
                      >
                        {t("media_pool.proxy_failed", {
                          defaultValue: "Preview failed",
                        })}
                      </span>
                    )}
                    {/* Bare corner dot — this clip is fully editable. */}
                    {showOptimizingDot && (
                      <span
                        className="media-optimizing-dot"
                        role="status"
                        aria-label={t("media_pool.optimizing")}
                        title={withReason(t("media_pool.optimizing_hint"))}
                      />
                    )}
                  </div>
                  <span className="media-item-name" title={m.label}>
                    {m.label}
                  </span>
                  {layout === "list" && (
                    // Compact rows have no room for the hover-revealed metadata
                    // gradient (hidden in CSS); surface the duration inline
                    // instead, like a file manager's details column.
                    <span className="media-item-meta-inline">
                      {m.duration_us !== null
                        ? formatMediaDuration(m.duration_us)
                        : t("media_pool.no_duration")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

/// A Group in the pool list, wearing the same `.media-item` card skin as an
/// imported file — because to this Panel it is the same kind of thing, a source
/// dragged onto a timeline.
///
/// The thumbnail frame holds a glyph and nothing else: **no thumbnail is ever
/// rendered or fetched for a composition.** Its pixels change whenever a member
/// is edited, so a real frame would need a derivative with its own invalidation
/// model and job queue; the first member's thumbnail would show something that
/// is not the Group. See `.scratch/pool-unification/spec.md`.
///
/// The menu state stays with the Panel — one state for both kinds of card — so
/// this reports the anchor point and nothing more.
function GroupPoolCard({
  item,
  layout,
  onMenu,
}: {
  item: GroupPoolItem;
  layout: MediaPoolLayout;
  /// Viewport coordinates to open this card's menu at; `null` closes it.
  onMenu: (at: { x: number; y: number } | null) => void;
}) {
  const { t } = useTranslation();
  const selected = useSelectedCompositionId() === item.id;
  const beginDrag = useMediaDragStore((s) => s.begin);
  const endDrag = useMediaDragStore((s) => s.end);
  // An empty composition has nothing to window, so placing it would be refused
  // at the commit (`InvalidArgument`). Refusing the DRAG means the gesture never
  // starts — the same prevention the card gives an unready import.
  const placeable = item.durationUs > 0;
  const isolated = item.refCount === 0;
  const duration = formatMediaDuration(item.durationUs);
  const refs = t("media_pool.groups_refs", { count: item.refCount });

  const openMenuAt = (x: number, y: number) => {
    setCompositionSelection(item.id);
    onMenu({ x, y });
  };

  return (
    <li
      data-composition-id={item.id}
      data-ref-count={item.refCount}
      className={[
        "media-item",
        placeable ? "" : "is-not-placeable",
        isolated ? "is-isolated" : "",
        selected ? "is-selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={placeable}
      tabIndex={0}
      aria-haspopup="menu"
      aria-keyshortcuts="Shift+F10"
      aria-selected={selected}
      title={
        placeable
          ? t("media_pool.groups_card_hint")
          : t("media_pool.groups_empty_hint")
      }
      onClick={() => setCompositionSelection(item.id)}
      onDoubleClick={() => openComposition(item.id, null)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenuAt(e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          openComposition(item.id, null);
          return;
        }
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        openMenuAt(
          rect.left + Math.min(32, rect.width / 2),
          rect.top + Math.min(32, rect.height / 2),
        );
      }}
      onDragStart={(e) => {
        onMenu(null);
        const payload = compositionDragPayload(
          { id: item.id, duration_us: item.durationUs },
          item.name,
        );
        beginDrag(payload, poolDragVisual(e.currentTarget, e.clientX, e.clientY));
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "copy";
        hideNativeDragPreview(e.dataTransfer);
      }}
      onDragEnd={endDrag}
    >
      <div className="media-item-thumb">
        <GroupIcon className="media-group-glyph" aria-hidden />
        <span className="media-kind kind-group">
          {t("kinds.compositionref", { defaultValue: "Group" })}
        </span>
        <div className="media-item-metadata">
          <span className="media-duration-badge">{duration}</span>
          <span className="media-duration-badge">{refs}</span>
        </div>
      </div>
      <span className="media-item-name" title={item.name}>
        {isolated && (
          <>
            <span
              data-testid="group-pool-isolated"
              className="media-item-isolated-tag"
            >
              {t("media_pool.groups_isolated")}
            </span>{" "}
          </>
        )}
        {item.name}
      </span>
      {layout === "list" && (
        // The hover-revealed metadata gradient is hidden on a compact row, so
        // the same two facts run inline, like a file manager's details column.
        <span className="media-item-meta-inline">
          {duration} · {refs}
        </span>
      )}
    </li>
  );
}

function RemoveMediaDialog({
  target,
  summary,
  ordinals,
  fpsNum,
  fpsDen,
  onReferencesChanged,
  onClose,
  onRemoved,
}: {
  target: MediaRemovalTarget;
  summary: ProjectSummary | null;
  ordinals: ReadonlyMap<string, number>;
  fpsNum: number;
  fpsDen: number;
  onReferencesChanged: (references: MediaReference[]) => void;
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const force = target.references.length > 0;

  const confirmRemoval = async () => {
    setRemoving(true);
    setError(null);
    try {
      await removeMedia(target.media.id, force);
    } catch (cause) {
      const referencedBy = parseMediaInUseLayerIds(cause);
      if (referencedBy !== null && !force) {
        onReferencesChanged(
          mediaReferencesFor(
            target.media.id,
            summary,
            ordinals,
            t,
            referencedBy,
          ),
        );
      } else {
        setError(
          t("media_pool.remove_failed", {
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
      setRemoving(false);
      return;
    }

    await onRemoved().catch(() => undefined);
    onClose();
  };

  return (
    <AppDialog
      title={t(
        force
          ? "media_pool.remove_in_use_title"
          : "media_pool.remove_title",
      )}
      onClose={() => {
        if (!removing) onClose();
      }}
      showClose={!removing}
      panelClassName="settings-panel media-remove-dialog"
    >
      <div className="settings-body">
        <div className="settings-card">
          {force ? (
            <>
              <p className="settings-blurb media-remove-copy">
                {t("media_pool.remove_in_use_body", {
                  label: target.media.label,
                  count: target.references.length,
                })}
              </p>
              <ul className="media-remove-reference-list">
                {target.references.map((reference) => (
                  <li key={reference.layerId} title={reference.layerId}>
                    <span className="media-remove-reference-name">
                      {reference.name}
                    </span>
                    <span className="media-remove-reference-meta">
                      {mediaReferenceMeta(reference, fpsNum, fpsDen)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="settings-warn media-remove-note">
                {t("media_pool.remove_in_use_note")}
              </p>
            </>
          ) : (
            <>
              <p className="settings-blurb media-remove-copy">
                {t("media_pool.remove_body", {
                  label: target.media.label,
                })}
              </p>
              <p className="settings-warn media-remove-note">
                {t("media_pool.remove_unused_note")}
              </p>
            </>
          )}
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
          <div className="export-actions">
            <Button size="lg" disabled={removing} onClick={onClose}>
              {t("media_pool.remove_cancel")}
            </Button>
            <Button
              variant="destructive"
              size="lg"
              disabled={removing}
              onClick={() => void confirmRemoval()}
            >
              {removing
                ? t("media_pool.removing")
                : force
                  ? t("media_pool.remove_force_confirm", {
                      count: target.references.length,
                    })
                  : t("media_pool.remove_confirm")}
            </Button>
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
