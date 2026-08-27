// A/B-roll context panel. Owns mode gating, row presentation, the two
// navigation gestures (pick vs Go To — see the props below), the
// At-playhead restack drag (grip per visual stack row) and the row context
// menu (the drag's non-drag equivalent); double-click renames via the
// recorded Layer label command — or, on a folded link row, the link's label.
// A link's listed members arrive folded into one row (`playheadItems.ts`);
// this panel draws the fold (accent, `×N`, stacked thumbnails, the expand
// chevron) and commits the link's own actions (rename, unlink) straight
// through IPC, the `project:changed` bridge refreshing the view. Windowing,
// filtering, the At-playhead / Nearby split and the drop's / menu's anchor
// mappings live in `playheadItems.ts` (ADR 0044). The top row is a toolbar —
// category chips plus the ±Δ window dial — and outside A/B Roll the panel
// renders an explainer instead of rows.

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CrosshairIcon,
  FilmIcon,
  GripVerticalIcon,
  MusicIcon,
  TypeIcon,
} from "lucide-react";

import { AppSelect } from "../components/AppSelect";
import { tryMutate } from "../errors/tryMutate";
import { formatMediaDuration } from "../frames";
import { usePointerReorder } from "../hooks/usePointerReorder";
import { useReorderSettle } from "../hooks/useReorderSettle";
import {
  linksDissolve,
  linksRename,
  type LinkSummary,
  type TrackSummary,
} from "../ipc";
import { layerDisplayName } from "../lib/layerName";
import {
  setAppSettings,
  useDeltaWindowUs,
  useDisplayMode,
} from "../settings/appSettingsStore";
import { useEffectiveBindings } from "../shortcuts/bindings-context";
import { resolveAccelerator } from "../shortcuts/match";
import { usePlayheadTimeUsThrottled } from "../state/playheadStore";
import { useCloseOnAnchorMove } from "../timeline/contextMenuAnchor";
import { linkHue } from "../timeline/geometry";
import { MediaThumbnail } from "./MediaThumbnail";
import { PlayheadRowContextMenu } from "./PlayheadRowContextMenu";
import {
  buildPlayheadItems,
  formatPlayheadWindow,
  playheadCategory,
  playheadDeltaLabels,
  PLAYHEAD_CATEGORY_ORDER,
  PLAYHEAD_WINDOW_PRESETS_US,
  restackMenuTargets,
  restackTargetForGap,
  splitPlayheadSections,
  type PlayheadCategory,
  type PlayheadItem,
  type PlayheadSections,
  type RestackMenuTargets,
} from "./playheadItems";

/// No category checked — the unfiltered state, and the Panel's initial one.
/// A module constant so the `useMemo` that splits the sections sees a stable
/// reference until the user actually touches a chip.
const NO_CATEGORY_FILTER: ReadonlySet<PlayheadCategory> = new Set();

/// The name a row prints and is addressed by (title, menu label, rename
/// field). A folded link answers with its label when it has one; otherwise —
/// and on every other row — with the layer's display name, shared with the
/// timeline block and the inspector.
function rowLabel(
  item: PlayheadItem,
  t: (key: string, values: Record<string, unknown>) => string,
): string {
  if (item.linkMembers.length > 0 && item.linkLabel !== null) return item.linkLabel;
  return layerDisplayName(item.layer, t);
}

/// The link accent, in the hue every member wears on the timeline
/// (`LayerBlock`'s left border uses the same formula).
function linkAccent(linkId: string): string {
  return `hsl(${linkHue(linkId)} 75% 60%)`;
}

/// How many member thumbnails a folded row stacks. Past three the stack reads
/// as a smear at 32×24, and the `×N` glyph already carries the count.
const STACKED_THUMBS_MAX = 3;

export interface PlayheadPanelProps {
  tracks: TrackSummary[];
  /// `ProjectSummary.links`, the fold source: members the panel lists become
  /// one row per link. Required rather than defaulted — a panel fed tracks
  /// but no links would show a link as unrelated rows without any error.
  links: LinkSummary[];
  selectedLayerId: string | null;
  fpsNum: number;
  fpsDen: number;
  visible?: boolean;
  /// Plain pick: select + reveal the Track WITHOUT seeking, so the
  /// near-playhead observation window is not disturbed.
  onPick: (layerId: string, trackId: string) => void;
  /// Explicit Go To: seek to the Layer's start and scroll it into view. When
  /// omitted, the panel hides that optional action.
  onGoTo?: ((layerId: string, trackId: string, startUs: number) => void) | undefined;
  /// Commit a lightweight inline rename through the recorded Layer label
  /// command. The host wires this to `updateLayer` + summary refresh.
  onRename?: ((layerId: string, nextLabel: string) => void) | undefined;
  /// Restack `layerId` directly above/below `anchorLayerId` in the z-stack —
  /// ONE anchored op per completed drag (ADR 0044). The host wires this to
  /// the `restack_layer` command + summary refresh. When omitted, the
  /// At-playhead rows render without grips.
  onRestack?:
    | ((
        layerId: string,
        anchorLayerId: string,
        position: "above" | "below",
      ) => void)
    | undefined;
}

export function PlayheadPanel({
  tracks,
  links,
  selectedLayerId,
  fpsNum,
  fpsDen,
  visible = true,
  onPick,
  onGoTo,
  onRename,
  onRestack,
}: PlayheadPanelProps) {
  const { t } = useTranslation();
  const displayMode = useDisplayMode();
  const deltaWindowUs = useDeltaWindowUs();
  const currentTimeUs = usePlayheadTimeUsThrottled(100, visible);
  // Checked categories, empty = unfiltered (see `splitPlayheadSections`). Session
  // state, not a persisted preference: it answers "what am I looking for right
  // now", which is not a fact about the user that should outlive the question.
  const [filter, setFilter] =
    useState<ReadonlySet<PlayheadCategory>>(NO_CATEGORY_FILTER);
  // The All Tracks explainer names the key that ends that state. Read from the
  // effective bindings — never hard-coded — so a rebound (or cleared)
  // display-mode chord can't leave the hint lying.
  const displayModeBinding = useEffectiveBindings("toggleDisplayMode");

  const items = useMemo(() => {
    if (displayMode !== "AbRoll") return [];
    return buildPlayheadItems(tracks, currentTimeUs, deltaWindowUs, t, links);
  }, [tracks, links, currentTimeUs, deltaWindowUs, displayMode, t]);

  const live = useMemo(
    () => splitPlayheadSections(items, filter),
    [items, filter],
  );

  // ── Folded link rows ───────────────────────────────────────────────────
  // Which folds are open, by link id. Session state like the filter: it
  // answers "which link am I looking into", and a link that leaves the window
  // and returns reopening on its own is the expected reading of that.
  const [expandedLinks, setExpandedLinks] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleExpanded = (linkId: string) => {
    setExpandedLinks((current) => {
      const next = new Set(current);
      if (!next.delete(linkId)) next.add(linkId);
      return next;
    });
  };
  // The context menu's Rename link… hands the fold's row its inline editor
  // (the row consumes the request as it opens the editor). One slot: a menu
  // is open on one row at a time, so one pending rename is all there can be.
  const [linkRenameRequest, setLinkRenameRequest] = useState<string | null>(null);

  // Committed straight through IPC rather than through a host-wired handler
  // like `onRename` / `onRestack`: the link is the panel's own row, not a
  // layer the host addresses, and the `project:changed` bridge refreshes the
  // summary either way. Empty clears the label — a link has no name by
  // default (`LinkSummary.label: null`), so clearing is a real destination.
  const renameLink = (linkId: string, label: string | null) =>
    void tryMutate(() => linksRename(linkId, label), "Rename link");
  const unlink = (linkId: string) =>
    void tryMutate(() => linksDissolve(linkId), "Unlink");

  // Each chip is independent: toggling one never clears the others.
  // `Set.delete` reports whether the category was there, so one call decides
  // both directions.
  const toggleCategory = (category: PlayheadCategory) => {
    setFilter((current) => {
      const next = new Set(current);
      if (!next.delete(category)) next.add(category);
      return next;
    });
  };

  // ── At-playhead restack gesture (ADR 0044 decision 6) ──────────────────
  // Mechanics — and why pointer events, never HTML5 DnD — live in usePointerReorder.
  //
  // The row snapshot freezes for the duration of a gesture: the playhead
  // ticks on a throttle and must never reshuffle rows under the pointer.
  // Both are written at grip pointerdown and only read while the hook
  // reports an active drag; they go stale (not cleared) after the gesture
  // and the next pointerdown overwrites them.
  const [frozen, setFrozen] = useState<PlayheadSections | null>(null);
  const gestureRowsRef = useRef<PlayheadItem[]>([]);

  // Gesture presentation (the semantics above stay in the hook): the grabbed
  // row follows the pointer through --playhead-drag-y — written imperatively per
  // frame on the stack section so the follow never rides the render loop —
  // and the drop lands through useReorderSettle, which holds the row at its
  // release position until the async restack's new order renders, then
  // glides it into the slot.
  const stackSectionRef = useRef<HTMLElement | null>(null);
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const settle = useReorderSettle((id) => rowEls.current.get(id) ?? null);

  const reorder = usePointerReorder({
    // Read per render. A pointerdown can only start on the displayed rows,
    // which are the live ones whenever no gesture is armed.
    rowIds: live.atPlayheadVisual.map((row) => row.layer.id),
    onDragFrame: (offsetY) => {
      stackSectionRef.current?.style.setProperty("--playhead-drag-y", `${offsetY}px`);
    },
    onDrop: ({ fromIndex, gap }) => {
      // Resolve against the pointerdown snapshot — the same rows the user
      // grabbed and has been looking at all gesture long.
      const rows = gestureRowsRef.current;
      const target = restackTargetForGap(rows, fromIndex, gap);
      const mover = rows[fromIndex];
      if (!target || !mover) return;
      // Measured now, while the row still sits at its pointer-follow
      // position — the drag class (and its transform) is gone by the
      // post-drop render.
      const el = rowEls.current.get(mover.layer.id);
      if (el) settle.arm(mover.layer.id, el);
      onRestack?.(mover.layer.id, target.anchorId, target.position);
    },
  });

  const sections = reorder.drag && frozen ? frozen : live;
  const { atPlayhead, nearby } = sections;
  const visualRows = sections.atPlayheadVisual;

  const startRestackDrag = (index: number, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    settle.cancel(); // a re-grab mid-glide must start from clean styles
    gestureRowsRef.current = visualRows;
    setFrozen(sections);
    reorder.startDrag(index, e);
  };

  // ── Row context menu (ADR 0044 decision 4) ─────────────────────────────
  // The grip drag's non-drag equivalent: four ordering items, offered only
  // where there is something to order — At-playhead visual rows (audio and
  // Nearby rows get no menu at all rather than an empty one). Anchors and
  // enablement resolve against the visible stack at open time, so the
  // playhead ticking under an open menu can't retarget a chosen item; the
  // anchored op stays valid because it re-resolves against the anchor's
  // track at apply time. One item click = one restack = one history entry.
  //
  // A folded link row adds the link's two actions, and is the one row that
  // opens a menu outside the visual stack — there the menu is link-only.
  const [rowMenu, setRowMenu] = useState<{
    x: number;
    y: number;
    layerId: string;
    label: string;
    targets: RestackMenuTargets | null;
    link: { id: string; label: string | null } | null;
  } | null>(null);

  // Coordinates are viewport-fixed, so the menu closes once the row it belongs
  // to scrolls out from under it (the media pool's convention) — measured on the
  // row, not inferred from a `scroll` event, which the popup's own opening fires
  // with nothing having moved. See `useCloseOnAnchorMove`.
  const closeRowMenu = useCallback(() => setRowMenu(null), []);
  useCloseOnAnchorMove(
    rowMenu ? (rowEls.current.get(rowMenu.layerId) ?? null) : null,
    closeRowMenu,
  );

  /// `stackIndex` is the row's index in the visible visual stack when it has
  /// one — that is what carries the ordering items; a folded row carries the
  /// link items wherever it sits.
  const openRowMenu = (
    item: PlayheadItem,
    stackIndex: number | undefined,
    x: number,
    y: number,
  ) => {
    const inStack =
      stackIndex !== undefined && visualRows[stackIndex]?.layer.id === item.layer.id;
    const link =
      item.linkMembers.length > 0 && item.linkId !== null
        ? { id: item.linkId, label: item.linkLabel }
        : null;
    if (!inStack && !link) return;
    setRowMenu({
      x,
      y,
      layerId: item.layer.id,
      label: rowLabel(item, t),
      targets: inStack && onRestack ? restackMenuTargets(visualRows, stackIndex) : null,
      link,
    });
  };

  // Rows render identically in both sections — a row's information set
  // (thumbnail / icon, name, track name, playhead relation, duration) does not
  // depend on which side of the playhead boundary it landed on; only WHICH
  // question the relation answers does (`playheadDeltaLabels`). An
  // At-playhead index adds the reorder chrome (grip, rect registration,
  // drag / insertion-indicator classes) to the section's visual prefix; the
  // audio tail and the Nearby section stay grip-less.
  //
  // A folded link row renders through the same path, standing on its nearest
  // member; when expanded, its members follow as indented plain rows
  // (`member` set) — no grip, no menu, no rect registration, because the fold
  // above them already holds the nearest member's slot in every one of those.
  const renderRow = (
    item: PlayheadItem,
    stackIndex?: number,
    member = false,
  ): ReactNode => {
    const draggable =
      !member && stackIndex !== undefined && stackIndex < visualRows.length;
    const dragging = draggable && reorder.drag?.id === item.layer.id;
    const gap = reorder.indicatorGap;
    const rowClassName = draggable
      ? [
          dragging ? "playhead-row--dragging" : "",
          // Rows at/past the active gap part downward to open the slot; the
          // dragged row never parts — its transform is the pointer follow.
          !dragging && gap !== null && stackIndex >= gap
            ? "playhead-row--parted"
            : "",
          gap === stackIndex ? "playhead-row--drop-before" : "",
          gap === visualRows.length && stackIndex === visualRows.length - 1
            ? "playhead-row--drop-after"
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "";
    const folded = !member && item.linkMembers.length > 0;
    const expanded = folded && item.linkId !== null && expandedLinks.has(item.linkId);
    const row = (
      <PlayheadRow
        // A member row shares its layer id with the fold standing on it, so
        // the two keys must differ within one list.
        key={member ? `member:${item.layer.id}` : item.layer.id}
        item={item}
        member={member}
        isSelected={item.layer.id === selectedLayerId}
        fpsNum={fpsNum}
        fpsDen={fpsDen}
        onReveal={() => onPick(item.layer.id, item.trackId)}
        onGoTo={
          onGoTo
            ? () => onGoTo(item.layer.id, item.trackId, item.layer.t_start_us)
            : undefined
        }
        onRename={
          folded
            ? (next) => renameLink(item.linkId!, next === "" ? null : next)
            : onRename
              ? (next) => onRename(item.layer.id, next)
              : undefined
        }
        renameRequested={folded && item.linkId === linkRenameRequest}
        onRenameRequestConsumed={() => setLinkRenameRequest(null)}
        expanded={folded ? expanded : undefined}
        onToggleExpanded={folded ? () => toggleExpanded(item.linkId!) : undefined}
        rowClassName={rowClassName === "" ? undefined : rowClassName}
        rowRef={
          member
            ? undefined
            : (el) => {
                if (draggable) reorder.setRowEl(stackIndex, el);
                if (el) rowEls.current.set(item.layer.id, el);
                else rowEls.current.delete(item.layer.id);
              }
        }
        onGripPointerDown={
          draggable && onRestack
            ? (e) => startRestackDrag(stackIndex, e)
            : undefined
        }
        onMenuOpen={
          (draggable && onRestack) || folded
            ? (x, y) => openRowMenu(item, stackIndex, x, y)
            : undefined
        }
      />
    );
    if (!expanded) return row;
    return (
      <Fragment key={item.layer.id}>
        {row}
        {item.linkMembers.map((m) => renderRow(m, undefined, true))}
      </Fragment>
    );
  };

  // All Tracks has no hidden tracks to surface, so nothing in the Panel
  // applies — not the sections, not the chips, not the window. It is the one
  // state that replaces the Panel body outright.
  if (displayMode !== "AbRoll") {
    return (
      <Explainer
        title={t("playhead_panel.all_tracks_title")}
        message={t("playhead_panel.all_tracks_msg")}
        hintKey={displayModeBinding ?? undefined}
      />
    );
  }

  return (
    <section className="right-panel-playhead" aria-label={t("playhead_panel.section_label")}>
      {/* Controls where a title bar would be, and deliberately not a title:
          the dock tab names the Panel, so a Panel that names itself spends
          its first line saying nothing. The chips grey out on an empty window
          (there is nothing to filter) but the dial never does — an empty
          window is precisely the moment the user wants to widen it. */}
      <div className="playhead-toolbar">
        <div
          className="playhead-filter"
          role="group"
          aria-label={t("playhead_panel.filter_label")}
        >
          {/* Checkboxes, not a radio set — `role="checkbox"` says so for
              screen readers, and the filled accent says so visually. No tick
              glyph: the fill IS the checked state, and a reserved gutter on
              every chip would spend width the toolbar does not have. */}
          {PLAYHEAD_CATEGORY_ORDER.map((category) => {
            const checked = filter.has(category);
            return (
              <button
                key={category}
                type="button"
                role="checkbox"
                aria-checked={checked}
                className={`playhead-filter-chip ${checked ? "is-active" : ""}`}
                disabled={items.length === 0}
                onClick={() => toggleCategory(category)}
              >
                {t(`playhead_panel.cat_${category}`, { defaultValue: category })}
              </button>
            );
          })}
        </div>
        <PlayheadWindowControl valueUs={deltaWindowUs} />
      </div>
      <div className="right-panel-playhead-results">
        {items.length === 0 ? (
          // An empty ±Δ window is a fact about where the playhead is, not a
          // broken Panel — and the sentence names both ways out, one of which
          // is the dial sitting directly above it.
          <>
            <p className="playhead-empty-title">{t("playhead_panel.empty_title")}</p>
            <p className="playhead-empty">
              {t("playhead_panel.empty_msg", {
                window: formatPlayheadWindow(deltaWindowUs, t),
              })}
            </p>
          </>
        ) : atPlayhead.length === 0 && nearby.length === 0 ? (
          <p className="playhead-filter-empty">{t("playhead_panel.filter_empty")}</p>
        ) : (
          <>
            {/* The stack being composited right now, top-of-stack first.
                Always present: an empty stack is a fact worth stating, not
                a section to hide. The container ref anchors the reorder
                gesture's edge auto-scroll. */}
            <section
              ref={(el) => {
                reorder.containerRef.current = el;
                stackSectionRef.current = el;
              }}
              className={[
                "playhead-section",
                reorder.drag ? "playhead-stack--reordering" : "",
                // An active (non-noop) gap: the list opens bottom room for
                // the parted rows' slot.
                reorder.indicatorGap !== null ? "playhead-stack--parting" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label={t("playhead_panel.section_at_playhead")}
            >
              {/* POST-filter, labelling exactly the rows underneath it — a
                  count that can never disagree with what is on screen. Hidden
                  at zero: the empty line below already says it. */}
              <div className="playhead-section-header">
                {t("playhead_panel.section_at_playhead")}
                {atPlayhead.length > 0 && (
                  <span className="playhead-section-count">{atPlayhead.length}</span>
                )}
              </div>
              {atPlayhead.length === 0 ? (
                <p className="playhead-stack-empty">{t("playhead_panel.at_playhead_empty")}</p>
              ) : (
                <ul className="right-panel-playhead-list">
                  {atPlayhead.map((item, i) => renderRow(item, i))}
                </ul>
              )}
            </section>
            {nearby.length > 0 && (
              <section
                className="playhead-section"
                aria-label={t("playhead_panel.section_nearby")}
              >
                <div className="playhead-section-header">
                  {t("playhead_panel.section_nearby")}
                  <span className="playhead-section-count">{nearby.length}</span>
                </div>
                <ul className="right-panel-playhead-list">
                  {nearby.map((item) => renderRow(item))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
      {rowMenu && (
        <PlayheadRowContextMenu
          key={`${rowMenu.layerId}:${rowMenu.x}:${rowMenu.y}`}
          x={rowMenu.x}
          y={rowMenu.y}
          label={rowMenu.label}
          targets={rowMenu.targets}
          link={rowMenu.link}
          onClose={() => setRowMenu(null)}
          onAction={(target) => {
            setRowMenu(null);
            onRestack?.(rowMenu.layerId, target.anchorId, target.position);
          }}
          onRenameLink={(linkId) => {
            setRowMenu(null);
            setLinkRenameRequest(linkId);
          }}
          onUnlink={(linkId) => {
            setRowMenu(null);
            unlink(linkId);
          }}
        />
      )}
    </section>
  );
}

/// The ±Δ window dial. `delta_window_us` is app-level and THIS Panel is its
/// only reader, so the dial belongs where its effect is visible rather than
/// in the settings dialog — the arrangement `media_pool_layout` already uses,
/// and one surface per value is one that cannot drift from a twin.
///
/// Presets only (see `PLAYHEAD_WINDOW_PRESETS_US`), except that a value written
/// out of band — MCP, a hand-edited app_settings.json, a future clamp change —
/// joins the list for as long as it is current. A select whose value is
/// absent from its options renders a blank trigger, and a blank dial reading
/// as "unset" would be a lie about a setting that always has a value.
function PlayheadWindowControl({ valueUs }: { valueUs: number }) {
  const { t } = useTranslation();
  const options = useMemo(() => {
    const values = PLAYHEAD_WINDOW_PRESETS_US.includes(valueUs)
      ? [...PLAYHEAD_WINDOW_PRESETS_US]
      : [...PLAYHEAD_WINDOW_PRESETS_US, valueUs].sort((a, b) => a - b);
    return values.map((us) => ({
      value: String(us),
      label: `±${formatPlayheadWindow(us, t)}`,
    }));
  }, [valueUs, t]);

  return (
    <AppSelect
      className="playhead-window-select"
      value={String(valueUs)}
      options={options}
      ariaLabel={t("playhead_panel.window_label")}
      // Fire-and-forget like the media pool's layout chips: main clamps and
      // persists, then broadcasts `app_settings:changed`, and the store's
      // write is what re-renders this Panel. Nothing local to roll back.
      onValueChange={(next) =>
        void setAppSettings({ delta_window_us: Number(next) })
      }
    />
  );
}

/// The All Tracks state, which replaces the Panel body outright. An explainer
/// with a way out of the state passes `hintKey` — the binding to render as the
/// closing call to action.
function Explainer({
  title,
  message,
  hintKey,
}: {
  title: string;
  message: string;
  hintKey?: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <section className="right-panel-playhead" aria-label={t("playhead_panel.section_label")}>
      <p className="playhead-empty-title">{title}</p>
      <p className="playhead-empty">{message}</p>
      {hintKey && (
        <p className="playhead-empty-hint">
          {/* The accelerator rides a <kbd> pill, the search palette's
              vocabulary for "this is a key you can press". */}
          <Trans
            i18nKey="playhead_panel.all_tracks_hint"
            values={{ key: resolveAccelerator(hintKey) }}
            components={{ key: <kbd className="playhead-empty-kbd" /> }}
          />
        </p>
      )}
    </section>
  );
}

function PlayheadRow({
  item,
  member,
  isSelected,
  fpsNum,
  fpsDen,
  onReveal,
  onGoTo,
  onRename,
  renameRequested,
  onRenameRequestConsumed,
  expanded,
  onToggleExpanded,
  rowClassName,
  rowRef,
  onGripPointerDown,
  onMenuOpen,
}: {
  item: PlayheadItem;
  /// A member listed under its expanded fold: indented and plain — the fold
  /// above it carries the link's glyph, chevron and menu.
  member: boolean;
  isSelected: boolean;
  fpsNum: number;
  fpsDen: number;
  onReveal: () => void;
  onGoTo?: (() => void) | undefined;
  /// Inline-rename commit. On a folded row this names the LINK, and an empty
  /// draft is passed through (the caller maps it to `null`); on a layer row an
  /// empty draft reverts, because the label command cannot clear to null.
  onRename?: ((nextLabel: string) => void) | undefined;
  /// The context menu's Rename link…: opens the same inline editor a
  /// double-click does. The row consumes the request as it opens the editor.
  renameRequested: boolean;
  onRenameRequestConsumed: () => void;
  /// Folded rows only — whether the members are listed underneath, and the
  /// chevron that flips it. Absent on every other row.
  expanded?: boolean | undefined;
  onToggleExpanded?: (() => void) | undefined;
  /// Reorder-gesture presentation owned by the panel (see usePointerReorder):
  /// drag / insertion-indicator classes for the row's <li>.
  rowClassName?: string | undefined;
  /// Registers the <li> as the live rect source for gap hit-testing. Present
  /// only on At-playhead visual rows.
  rowRef?: ((el: HTMLLIElement | null) => void) | undefined;
  /// When present the row shows a grip and is draggable to restack.
  onGripPointerDown?: ((e: ReactPointerEvent) => void) | undefined;
  /// When present the row opens the ordering context menu at (x, y):
  /// right-click, or ContextMenu / Shift+F10 from the keyboard (the media
  /// pool's vocabulary). Present only on At-playhead visual rows.
  onMenuOpen?: ((x: number, y: number) => void) | undefined;
}) {
  const { t } = useTranslation();
  const durationUs = item.layer.t_end_us - item.layer.t_start_us;
  // The row's two times, deliberately in two vocabularies (`formatPlayheadDelta`):
  // the playhead relation as a phrase carrying unit letters, the length as the
  // media pool's MM:SS. Neither prints a field name, and the shapes are
  // different enough that neither needs one.
  const delta = playheadDeltaLabels(item, fpsNum, fpsDen, t);
  const durationLabel = formatMediaDuration(durationUs);
  const durationAria = t("playhead_panel.duration_aria", { value: durationLabel });
  const folded = !member && item.linkMembers.length > 0;
  // A folded row stacks its members' media, nearest on top; a lone row shows
  // its own. Either way an empty list falls back to the kind icon.
  const thumbSources = (folded ? item.linkMembers : [item])
    .filter((source) => thumbMediaIdOf(source) !== null)
    .slice(0, STACKED_THUMBS_MAX);
  const primaryLabel = rowLabel(item, t);
  const accent = item.linkId !== null ? linkAccent(item.linkId) : null;

  // Inline rename. Enter commits, Escape cancels, click-away commits — all
  // funnelled through `commit`/`cancel`, which a single latch (`settled`)
  // guards so a key-driven finish can't also fire the follow-up blur.
  const currentLabel = folded ? (item.linkLabel ?? "") : (item.layer.label ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const settled = useRef(false);

  const startEdit = () => {
    if (!onRename) return;
    settled.current = false;
    setDraft(currentLabel);
    setEditing(true);
  };
  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const next = draft.trim();
    // An unchanged value records no undo entry. Empty reverts on a layer row
    // (the label command can't clear to null) and clears on a folded one.
    if (next === currentLabel || (next === "" && !folded)) return;
    onRename?.(next);
  };
  const cancel = () => {
    settled.current = true;
    setEditing(false);
  };
  useEffect(() => {
    if (!renameRequested) return;
    onRenameRequestConsumed();
    startEdit();
    // The request is the only trigger; the handlers it reaches are the
    // render's own and need no re-subscription.
  }, [renameRequested]);

  // Right-click anywhere on the row opens the ordering menu at the cursor;
  // the keyboard opener anchors it inside the row's own rect instead.
  // Both funnel through `onMenuOpen` so the panel owns what the menu shows.
  const openMenuFromPointer = onMenuOpen
    ? (e: ReactMouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onMenuOpen(e.clientX, e.clientY);
      }
    : undefined;
  const openMenuFromKeyboard = onMenuOpen
    ? (e: ReactKeyboardEvent) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        onMenuOpen(
          rect.left + Math.min(32, rect.width / 2),
          rect.top + Math.min(32, rect.height / 2),
        );
      }
    : undefined;

  // The member indent is inline, as is the link accent below: both are a
  // function of row data, not of a state the stylesheet could address.
  const liClassName =
    [rowClassName, member ? "playhead-row--member" : ""].filter(Boolean).join(" ") ||
    undefined;
  const liStyle = member ? { paddingLeft: 20 } : undefined;

  if (editing) {
    return (
      // Keeps the row ref through a rename so a concurrent gesture on a
      // sibling row still hit-tests against every visual row's rect.
      <li className={liClassName} style={liStyle} ref={rowRef}>
        <input
          className="playhead-rename-input"
          aria-label={t("playhead_panel.rename_label", { label: primaryLabel })}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          onBlur={commit}
        />
      </li>
    );
  }

  return (
    <li
      className={liClassName}
      style={liStyle}
      ref={rowRef}
      data-link-id={item.linkId ?? undefined}
      onContextMenu={openMenuFromPointer}
      onKeyDown={openMenuFromKeyboard}
    >
      {/* Hover / selection / LIVE paint on the ROW, not the inner button —
          the grip and Go To must sit on the same surface as the content.
          The link accent is an inset shadow rather than a border so a linked
          row's content lines up with its unlinked neighbours'. */}
      <div
        className={`playhead-item-row ${isSelected ? "is-selected" : ""} ${
          item.spansPlayhead ? "is-live" : ""
        }`}
        style={accent ? { boxShadow: `inset 2px 0 0 ${accent}` } : undefined}
      >
        {/* Restack affordance (ADR 0044 decision 6): the row body already
            spends click on select and double-click on rename, so the drag
            needs its own handle. Pointer-only — see usePointerReorder. */}
        {onGripPointerDown && (
          <span
            className="playhead-grip"
            title={t("playhead_panel.restack_grip", { label: primaryLabel })}
            aria-label={t("playhead_panel.restack_grip", { label: primaryLabel })}
            onPointerDown={onGripPointerDown}
          >
            <GripVerticalIcon size={13} />
          </span>
        )}
        <button
          type="button"
          className={`playhead-item kind-${item.trackKind.toLowerCase()} ${
            isSelected ? "is-selected" : ""
          } ${item.spansPlayhead ? "is-live" : ""}`}
          onClick={onReveal}
          onDoubleClick={onRename ? startEdit : undefined}
          title={primaryLabel}
          // Announced on the focusable element, like the media pool's cards:
          // the ordering menu is a keyboard path, not a pointer-only one.
          aria-haspopup={onMenuOpen ? "menu" : undefined}
          aria-keyshortcuts={onMenuOpen ? "Shift+F10" : undefined}
        >
          <span className="playhead-thumb" style={{ position: "relative" }}>
            {thumbSources.length === 0 ? (
              <span className="playhead-thumb-fallback" aria-hidden="true">
                {iconForCategory(playheadCategory(item.layer.params.kind))}
              </span>
            ) : (
              // Farthest member painted first so the nearest lands on top at
              // the thumb's own position; each one behind it peeks out a few
              // pixels up and to the right.
              [...thumbSources].reverse().map((source, i, all) => {
                const depth = all.length - 1 - i;
                return (
                  <span
                    key={source.layer.id}
                    style={
                      all.length > 1
                        ? {
                            position: "absolute",
                            inset: 0,
                            transform: `translate(${depth * 3}px, ${-depth * 2}px)`,
                          }
                        : undefined
                    }
                  >
                    <MediaThumbnail
                      mediaId={thumbMediaIdOf(source)!}
                      mediaKind={source.trackKind}
                    />
                  </span>
                );
              })
            )}
          </span>
          <span className="playhead-meta">
            <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
              <span className="playhead-label">{primaryLabel}</span>
              {/* Every linked row that is not itself a member wears the
                  link's size — the fold and the lone listed member alike; the
                  hue ties the glyph to the stripe. */}
              {accent && !member && item.linkSize > 1 && (
                <span
                  data-testid="playhead-row-link-count"
                  aria-label={t("playhead_panel.link_count_aria", {
                    count: item.linkSize,
                  })}
                  style={{
                    flex: "0 0 auto",
                    fontSize: "var(--font-size-caption)",
                    fontWeight: 600,
                    color: accent,
                  }}
                >
                  ×{item.linkSize}
                </span>
              )}
            </span>
            <span className="playhead-sublabel">{item.trackLabel}</span>
          </span>
          {/* The field names go where they cost no width: each value's
              accessible name, and one title covering both. A nested title wins
              over the button's inside this subtree, so hovering the numbers
              explains the numbers rather than repeating the clip's name. */}
          <span className="playhead-times" title={`${delta.aria} · ${durationAria}`}>
            <span
              className={`playhead-delta ${item.spansPlayhead ? "is-live" : ""}`}
              aria-label={delta.aria}
            >
              {delta.text}
            </span>
            <span className="playhead-duration" aria-label={durationAria}>
              {durationLabel}
            </span>
          </span>
        </button>
        {onToggleExpanded && (
          // Same inset pill as Go To, but never hidden at rest: the members
          // exist whether or not the pointer is on the row, and a disclosure
          // that only appears on hover is one nobody discovers.
          <button
            type="button"
            className="playhead-goto"
            style={{ opacity: 1 }}
            data-testid="playhead-row-expand"
            aria-expanded={expanded ?? false}
            onClick={onToggleExpanded}
            title={t(expanded ? "playhead_panel.collapse_link" : "playhead_panel.expand_link", {
              label: primaryLabel,
            })}
            aria-label={t(
              expanded ? "playhead_panel.collapse_link" : "playhead_panel.expand_link",
              { label: primaryLabel },
            )}
          >
            {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          </button>
        )}
        {onGoTo && (
          <button
            type="button"
            className="playhead-goto"
            onClick={onGoTo}
            title={t("playhead_panel.goto", { label: primaryLabel })}
            aria-label={t("playhead_panel.goto", { label: primaryLabel })}
          >
            <CrosshairIcon size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

/// The media a row's thumbnail shows, or null for kinds that have none.
function thumbMediaIdOf(item: PlayheadItem): string | null {
  return item.layer.params.kind === "VideoClip" ||
    item.layer.params.kind === "ImageOverlay"
    ? (item.layer.params.media_id ?? null)
    : null;
}

function iconForCategory(category: PlayheadCategory): ReactNode {
  switch (category) {
    case "video":
      return <FilmIcon size={14} />;
    case "audio":
      return <MusicIcon size={14} />;
    case "text":
      return <TypeIcon size={14} />;
  }
}
