import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Group as GroupIcon } from "lucide-react";

import { GroupPoolContextMenu } from "./GroupPoolContextMenu";
import { filterGroupPoolRows, groupPoolRows, type GroupPoolRow } from "./groupPoolRows";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { Button } from "../components/ui/button";
import { formatMediaDuration } from "../frames";
import { compositionsDelete, groupsRename } from "../ipc";
import { tryMutate } from "../errors/tryMutate";
import { openComposition } from "../state/compositionScopeStore";
import {
  useCompositionRefCounts,
  useGroupOrdinals,
  useProjectSummary,
} from "../state/projectStore";
import {
  setCompositionSelection,
  useSelectedCompositionId,
} from "../state/selectionStore";
import {
  MEDIA_DRAG_TYPE,
  compositionDragPayload,
  hideNativeDragPreview,
  poolDragVisual,
  useMediaDragStore,
} from "../timeline/mediaDrag";

/// The media pool's `Groups` section: one row per non-root composition.
///
/// It is the reuse surface a Group needs to be an entity at all — the place a
/// second instance is dragged from — and the home of an orphan, a composition
/// whose last Group clip was deleted. Keeping orphans visible here is what makes
/// them removable: ADR 0042 refused leaving state holding an entity no surface
/// can reach, and a composition, unlike a track, is not disposable by rule.
///
/// Reads the project store directly rather than taking rows as props: the
/// section's data is the whole composition set, which is not the media list its
/// host panel is given, and the counts it needs are indexed per summary in the
/// store (`compositionRefCounts`, `groupOrdinals`).
export function GroupPoolSection({
  query,
  onMutated,
}: {
  /// The pool's search text — one box governs both sections.
  query: string;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const summary = useProjectSummary();
  const ordinals = useGroupOrdinals();
  const refCounts = useCompositionRefCounts();
  const selectedCompositionId = useSelectedCompositionId();
  const beginDrag = useMediaDragStore((s) => s.begin);
  const endDrag = useMediaDragStore((s) => s.end);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    row: GroupPoolRow;
  } | null>(null);
  const [renaming, setRenaming] = useState<GroupPoolRow | null>(null);

  const rows = useMemo(
    () => (summary ? groupPoolRows(summary, ordinals, refCounts, t) : []),
    [summary, ordinals, refCounts, t],
  );
  const visible = useMemo(() => filterGroupPoolRows(rows, query), [rows, query]);

  // Viewport-fixed coordinates, so any ancestor scroll detaches the menu from
  // the row it belongs to (the media list's rule).
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [contextMenu]);

  // No heading over an empty section: a pool with no Groups should read as a
  // media pool, not as a feature with nothing in it.
  if (rows.length === 0) return null;

  return (
    <>
      {contextMenu && (
        <GroupPoolContextMenu
          key={`${contextMenu.row.compositionId}:${contextMenu.x}:${contextMenu.y}`}
          x={contextMenu.x}
          y={contextMenu.y}
          name={contextMenu.row.name}
          canDelete={contextMenu.row.refCount === 0}
          onClose={() => setContextMenu(null)}
          onOpen={() => {
            setContextMenu(null);
            openComposition(contextMenu.row.compositionId, null);
          }}
          onRename={() => {
            setContextMenu(null);
            setRenaming(contextMenu.row);
          }}
          onDelete={() => {
            const { compositionId } = contextMenu.row;
            setContextMenu(null);
            void tryMutate(
              () => compositionsDelete(compositionId),
              "compositions_delete",
            ).then((ok) => (ok ? onMutated() : undefined));
          }}
        />
      )}
      {renaming && (
        <RenameGroupDialog
          key={renaming.compositionId}
          row={renaming}
          storedLabel={summary?.compositions[renaming.compositionId]?.label ?? null}
          onClose={() => setRenaming(null)}
          onMutated={onMutated}
        />
      )}
      {/* Section divider inside the pool, not a Panel header: the dock tab is
          the Panel's title. `.media-pool-inner h2` already styles it, so the
          wrapper carries only the gap that separates the two sections. */}
      <div className="pt-3">
        <h2>{t("media_pool.groups_heading")}</h2>
        {visible.length === 0 ? (
          <p className="placeholder">
            {t("media_pool.groups_no_matches", { query: query.trim() })}
          </p>
        ) : (
          <ul data-testid="group-pool-list" className="flex flex-col gap-px">
            {visible.map((row) => {
              const unused = row.refCount === 0;
              return (
                <li
                  key={row.compositionId}
                  data-composition-id={row.compositionId}
                  data-ref-count={row.refCount}
                  className={[
                    "flex cursor-grab items-center gap-2 rounded px-2 py-1 text-xs",
                    selectedCompositionId === row.compositionId
                      ? "bg-secondary outline outline-1 -outline-offset-1 outline-primary"
                      : "hover:bg-secondary/60",
                    unused ? "opacity-55" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  // An empty composition has nothing to window, so placing it
                  // would be refused at the commit (`InvalidArgument`). Refusing
                  // the DRAG instead means the gesture never starts — the same
                  // prevention the media list applies to an unready import.
                  draggable={row.durationUs > 0}
                  tabIndex={0}
                  aria-haspopup="menu"
                  aria-keyshortcuts="Shift+F10"
                  aria-selected={selectedCompositionId === row.compositionId}
                  title={
                    row.durationUs > 0
                      ? t("media_pool.groups_row_hint")
                      : t("media_pool.groups_empty_hint")
                  }
                  onClick={() => setCompositionSelection(row.compositionId)}
                  onDoubleClick={() => openComposition(row.compositionId, null)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCompositionSelection(row.compositionId);
                    setContextMenu({ x: e.clientX, y: e.clientY, row });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      openComposition(row.compositionId, null);
                      return;
                    }
                    if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setCompositionSelection(row.compositionId);
                    setContextMenu({
                      x: rect.left + Math.min(32, rect.width / 2),
                      y: rect.top + rect.height / 2,
                      row,
                    });
                  }}
                  onDragStart={(e) => {
                    setContextMenu(null);
                    const payload = compositionDragPayload(
                      { id: row.compositionId, duration_us: row.durationUs },
                      row.name,
                    );
                    beginDrag(
                      payload,
                      poolDragVisual(e.currentTarget, e.clientX, e.clientY),
                    );
                    e.dataTransfer.setData(MEDIA_DRAG_TYPE, JSON.stringify(payload));
                    e.dataTransfer.effectAllowed = "copy";
                    hideNativeDragPreview(e.dataTransfer);
                  }}
                  onDragEnd={endDrag}
                >
                  <GroupIcon size={12} aria-hidden className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  {unused && (
                    <span
                      data-testid="group-pool-unused"
                      className="shrink-0 rounded bg-amber-500/20 px-1 text-[9px] font-semibold uppercase text-amber-200"
                    >
                      {t("media_pool.groups_unused")}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {formatMediaDuration(row.durationUs)}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t("media_pool.groups_refs", { count: row.refCount })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

/// Name a Group's composition. Writes `groups_rename`, not the clip's label: a
/// Group has both, and this surface names the composition every instance of it
/// shows.
function RenameGroupDialog({
  row,
  storedLabel,
  onClose,
  onMutated,
}: {
  row: GroupPoolRow;
  /// The composition's OWN label, `null` while the name is derived — the field
  /// seeds from this rather than from the displayed name, so opening the dialog
  /// on an unnamed Group offers an empty field with `Group N` as its placeholder
  /// instead of pre-filling a name the user never typed.
  storedLabel: string | null;
  onClose: () => void;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(storedLabel ?? "");

  const commit = async () => {
    const next = name.trim();
    // Blank clears the name back to the derived one; unchanged is an actor-level
    // no-op with no history row, so there is nothing to send.
    if (next !== (storedLabel ?? "")) {
      const ok = await tryMutate(
        () => groupsRename(row.compositionId, next || null),
        "groups_rename",
      );
      if (!ok) return;
      await onMutated();
    }
    onClose();
  };

  return (
    <AppDialog
      title={t("media_pool.groups_rename_title")}
      onClose={onClose}
      panelClassName="settings-panel"
    >
      <div className="settings-body">
        <div className="settings-card">
          <AppInput
            autoFocus
            value={name}
            placeholder={row.name}
            ariaLabel={t("media_pool.groups_rename_title")}
            onValueChange={setName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              }
            }}
          />
          <div className="export-actions">
            <Button size="lg" onClick={onClose}>
              {t("media_pool.remove_cancel")}
            </Button>
            <Button variant="default" size="lg" onClick={() => void commit()}>
              {t("media_pool.groups_rename_confirm")}
            </Button>
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
