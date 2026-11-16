import { useCallback, useMemo, useState } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useTranslation } from "react-i18next";
import { CircleHelp, StickyNote, TriangleAlert } from "lucide-react";
import type { TackKind } from "../../shared/agent-activity";
import { AppIcon } from "@/components/AppIcon";
import { AppMenuPositioner } from "../components/PopupPositioner";
import { MenuItem, closeContextMenuOn } from "../menu/Menu";
import { formatTimecode } from "../frames";
import { getCommand } from "../commands/registry";
import { useUiScale } from "../settings/layoutTheme";
import { UI_METRICS } from "../settings/uiMetrics";
import { useComposition } from "../state/projectStore";
import { releaseFocus, selectTack as focusTack, useReviewFocus } from "../agent/reviewFocus";
import { useCompositionTacks, useReviewLaneExists } from "../agent/tackModel";
import { locate } from "../agent/locate";
import { useRulerScrollBlockPx } from "./TimelineRuler";
import { groupLaneTacks, windowLaneTacks, type LaneTack, type LaneTackGroup } from "./rulerModel";
import { useCloseOnAnchorMove } from "./contextMenuAnchor";

/// The Review lane (ADR 0115): the tacks agents left for the user, as chips in
/// a row of their own between the marker lane and the drop strip.
///
/// Its own row, not a layer of the marker lane's. Tacks painted behind the
/// user's markers read as more markers, and vanished whenever the user hid
/// markers — the one switch that owns that row is about the user's marks, not
/// the agent's. Here the two never share ink, and `markers_visible` has no say.
///
/// A row in the ruler family like the marker lane: same row coordinates, same
/// quantised scroll window, so a chip and the tick above its start are the same
/// x. It EXISTS by `reviewLaneExists` — the overlay on and agent review
/// material seen in this project opening — never by how many tacks are open,
/// so an agent resolving or adding tacks mid-session cannot reflow the tracks.
/// One row high, the marker lane's height, whatever it holds: tacks whose chips
/// would touch share one group chip with a count (`groupLaneTacks`).
///
/// Never a scrub surface: the ruler stays the sole one. A chip click focuses
/// its tack (the review focus, shared with the agent panel) and shows its row;
/// a double-click locates it — the panel's Locate, and the one press here that
/// seeks. A group click lists its tacks to choose from. A click on bare lane
/// lets the focus go.
const REVIEW = UI_METRICS.timeline.review;

/// One icon per kind, the same the Tacks tab draws, so a chip and its panel
/// row are recognisably the same item.
const KIND_ICON: Record<TackKind, typeof StickyNote> = {
  note: StickyNote,
  issue: TriangleAlert,
  question: CircleHelp,
};

/// Focus the tack and show its row: the panel opens on the Tacks tab with the
/// row expanded and scrolled to (`TacksTab`).
const selectTack = (id: string) => {
  focusTack(id);
  void getCommand("openAgentPanel")?.run();
};

/// The lane's sticky-header cell: what the row is. The Review overlay's switch
/// is not here — turning it off removes this row, so it lives where it stays
/// reachable: the Quick Actions strip, the View menu and the palette
/// (`toggleReviewOverlay`). Reads the same existence rule as the lane, for the same reason the marker
/// lane's header does: a cell that outlived its row would slide every header
/// below it out of line with its lane.
export function ReviewLaneHeader() {
  const { t } = useTranslation();
  const scale = useUiScale();
  const exists = useReviewLaneExists();
  if (!exists) return null;
  return (
    <div
      data-testid="timeline-review-lane-header"
      className="flex items-center border-b border-border-soft bg-card px-1.5"
      style={{ height: REVIEW.laneHeight * scale }}
      // The header column is not a timeline surface (same guard as
      // `MarkerLaneHeader` and `TrackHeader`).
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="truncate text-[length:var(--font-size-fine)] uppercase tracking-wide text-muted-foreground/70">
        {t("timeline.review_lane")}
      </span>
    </div>
  );
}

export function ReviewLane({
  compositionId,
  pxPerSec,
  widthPx,
  viewportWidthPx,
  fpsNum,
  fpsDen,
}: {
  compositionId: string | null;
  pxPerSec: number;
  widthPx: number;
  viewportWidthPx: number;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const scale = useUiScale();
  const exists = useReviewLaneExists();
  const scrollLeftPx = useRulerScrollBlockPx(compositionId);
  const selected = useReviewFocus((s) => (s.focus?.kind === "tack" ? s.focus.id : null));
  // The Tacks tab row under the pointer, so the chip it names can be found.
  const hovered = useReviewFocus((s) => (s.hover?.kind === "tack" ? s.hover.id : null));
  // The group chip whose menu is open, and the element it hangs from.
  const [menu, setMenu] = useState<{ group: LaneTackGroup; anchor: HTMLElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useCloseOnAnchorMove(menu?.anchor ?? null, closeMenu);
  // `compositionId` null names the root, as everywhere on the timeline; tacks
  // carry the concrete id.
  const resolvedId = useComposition(compositionId)?.id ?? null;
  const tacks = useCompositionTacks(exists ? resolvedId : null);
  // Grouped once per tack set and zoom, not per scroll block: what joins a
  // group must not depend on which neighbours are on screen.
  const groups = useMemo(
    () =>
      groupLaneTacks({
        tacks,
        pxPerSec,
        minChipPx: REVIEW.chipMinWidth * scale,
        minGroupPx: REVIEW.groupMinWidth * scale,
      }),
    [tacks, pxPerSec, scale],
  );
  // Hover text composed per window, like the marker lane's: each line is a
  // pair of `formatTimecode` calls through the wasm frame grid.
  const painted = useMemo(() => {
    const line = (m: LaneTack) =>
      t("tacks.band_tooltip", {
        label: m.label,
        time:
          formatTimecode(m.tUs, fpsNum, fpsDen) +
          (m.endTUs === null ? "" : ` – ${formatTimecode(m.endTUs, fpsNum, fpsDen)}`),
      });
    return windowLaneTacks(groups, { scrollLeftPx, viewportWidthPx }).map((group) => ({
      group,
      title:
        group.members.length === 1
          ? line(group.members[0]!)
          : [t("tacks.band_group", { count: group.members.length }), ...group.members.map(line)].join("\n"),
    }));
  }, [groups, scrollLeftPx, viewportWidthPx, fpsNum, fpsDen, t]);
  // Dim the rest only while the selection is ON this lane: a selected tack
  // that is resolved, hibernating or on another composition paints nowhere
  // here, and dimming every chip for it would point at nothing.
  const selectionHere = selected !== null && groups.some((g) => g.members.some((m) => m.id === selected));

  // The row itself, not merely its contents — see `reviewLaneExists`.
  if (!exists) return null;

  const top = ((REVIEW.laneHeight - REVIEW.chipHeight) / 2) * scale;
  return (
    // `overflow-hidden` for the marker lane's reason: a chip running past
    // widthPx must not inflate the parent's scrollWidth.
    <div
      data-testid="timeline-review-lane"
      data-selecting={selectionHere ? "true" : undefined}
      className="review-lane relative flex-none select-none overflow-hidden border-b border-border-soft bg-card"
      style={{ width: widthPx, height: REVIEW.laneHeight * scale }}
      // Neither a scrub surface nor a selection surface (the marker lane's
      // guard): a press here must not start the body's marquee.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        // Bare lane, not a chip: nothing is pointed at any more.
        if (e.target === e.currentTarget) releaseFocus();
      }}
    >
      {painted.map(({ group, title }) => {
        const style = { left: group.xPx, width: group.widthPx, top, height: REVIEW.chipHeight * scale };
        if (group.members.length === 1) {
          const chip = group.members[0]!;
          return (
            <div
              key={chip.id}
              data-testid="timeline-tack"
              data-tack-id={chip.id}
              data-kind={chip.kind}
              data-selected={selected === chip.id ? "true" : undefined}
              data-hovered={hovered === chip.id ? "true" : undefined}
              title={title}
              className="review-tack"
              style={style}
              onClick={() => selectTack(chip.id)}
              onDoubleClick={() => {
                const tack = tacks.find((x) => x.id === chip.id);
                if (tack) locate({ kind: "tack", tack });
              }}
            >
              <AppIcon icon={KIND_ICON[chip.kind]} size="fine" className="review-tack-icon" />
              {chip.label.trim() !== "" && <span className="review-tack-label">{chip.label}</span>}
            </div>
          );
        }
        const ids = group.members.map((m) => m.id);
        // Labels in start order, so the chip still says what is there.
        const labels = group.members.map((m) => m.label.trim()).filter((l) => l !== "").join(" · ");
        return (
          <button
            key={ids[0]}
            type="button"
            data-testid="timeline-tack-group"
            data-tack-ids={ids.join(" ")}
            data-kind={group.kind}
            data-count={ids.length}
            data-selected={selected !== null && ids.includes(selected) ? "true" : undefined}
            data-hovered={hovered !== null && ids.includes(hovered) ? "true" : undefined}
            data-open={menu?.group.members[0]?.id === ids[0] ? "true" : undefined}
            aria-haspopup="menu"
            title={title}
            className="review-tack review-tack-group"
            style={style}
            onClick={(e) => setMenu({ group, anchor: e.currentTarget })}
          >
            <AppIcon icon={KIND_ICON[group.kind]} size="fine" className="review-tack-icon" />
            <span className="review-tack-count">{ids.length}</span>
            {labels !== "" && <span className="review-tack-label">{labels}</span>}
          </button>
        );
      })}
      {menu && <TackGroupMenu group={menu.group} anchor={menu.anchor} selected={selected} onClose={closeMenu} />}
    </div>
  );
}

/// A group chip's tacks, one row each in start order: choosing one focuses it
/// as a chip click would. The focused one is checked, so a group the panel
/// pointed into says which of its tacks that was.
function TackGroupMenu({
  group,
  anchor,
  selected,
  onClose,
}: {
  group: LaneTackGroup;
  anchor: HTMLElement;
  selected: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <MenuPrimitive.Root open modal={false} onOpenChange={closeContextMenuOn(onClose)}>
      <MenuPrimitive.Portal>
        <AppMenuPositioner anchor={anchor} side="bottom" align="start" sideOffset={2} className="app-popup-positioner">
          <MenuPrimitive.Popup className="app-menu-list" data-testid="timeline-tack-group-menu">
            {group.members.map((m) => {
              const kind = t(`tacks.kind_${m.kind}`);
              return (
                <MenuItem
                  key={m.id}
                  testId="timeline-tack-group-item"
                  label={m.label.trim() === "" ? kind : t("tacks.group_item", { kind, label: m.label })}
                  checked={selected === m.id}
                  onSelect={() => {
                    onClose();
                    selectTack(m.id);
                  }}
                />
              );
            })}
          </MenuPrimitive.Popup>
        </AppMenuPositioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
