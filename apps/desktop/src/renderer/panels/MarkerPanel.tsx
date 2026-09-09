// The Marker Panel: every marker in the PROJECT, grouped by the composition it
// belongs to, and the only surface a HIBERNATING marker appears on at all —
// which is what makes ADR 0056's hibernation policy honest rather than a way to
// lose a note quietly.
//
// Boundary: this Panel owns a marker's CONTENT — label, colour, note. The lane
// owns its POSITION, and TIME IS READ-ONLY here on every row, free markers
// included. An anchored marker's `t_us` is a cache the next `reconcileMarkers`
// rewrites, so a typed time would revert under the cursor; translating it into
// `src_us` instead would show a number that means something other than what was
// typed. One rule beats a cell that is editable on some rows only, and the
// gesture that does move a mark is the lane's drag.
//
// Scope is the WHOLE project, not the focused composition: "what have I marked"
// is a project-wide question, and scoping it would reproduce the blindness the
// anchoring effort began from — a mark inside a Group invisible from the root,
// merely in a list instead of on a lane.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Anchor, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { AppColorField, hexToRgba } from "../components/AppColorField";
import { AppInput } from "../components/AppInput";
import { tryMutate } from "../errors/tryMutate";
import { formatTimecode, formatWallClock } from "../frames";
import {
  detachMarker,
  removeMarker,
  renameMarker,
  setMarkerColor,
  setMarkerNote,
  type CompositionSummary,
  type MarkerSummary,
  type ProjectSummary,
} from "../ipc";
import { groupDisplayName, layerDisplayName } from "../lib/layerName";
import {
  focusedCompositionId,
  openComposition,
} from "../state/compositionAnchorStore";
import { jumpToLayer, jumpToTimeUs } from "../state/navigation";
import { focusedRootUs } from "../state/playheadProjection";
import {
  useGroupOrdinals,
  useProjectStore,
  useProjectSummary,
} from "../state/projectStore";

/// The hibernating section's key in the collapse set. Not a composition id, and
/// it cannot collide with one: compositions are uuids.
const HIBERNATING_SECTION = "hibernating";

/// Quiet window before a colour lands as a commit. The native swatch streams a
/// value for every movement inside the OS picker and `update_marker` coalesces
/// nothing, so committing per event would spend one undo entry per pixel of
/// drag. The draft paints immediately; this is what turns one gesture into one
/// entry.
const COLOR_COMMIT_QUIET_MS = 250;

/// Marker colour is opaque here by construction: the wire carries the colour as
/// `#rrggbb` (`markerColorHint`), so a swatch edit has no alpha to preserve.
const OPAQUE = 255;

/// One row's marker plus the composition it belongs to — the rate its timecode
/// is read at, and the timeline an activation has to open first.
interface PanelMarker {
  marker: MarkerSummary;
  compositionId: string;
  fpsNum: number;
  fpsDen: number;
}

interface PanelSection {
  /// A composition id, or `HIBERNATING_SECTION`.
  id: string;
  name: string;
  markers: PanelMarker[];
}

/// Root first, then Groups by their stored ordinal. The root is not a Group and
/// is never named as one — it IS the timeline, so it takes the Panel kind's own
/// title, exactly as it does on a timeline tab and in the `Ctrl+K` palette.
function buildSections(
  summary: ProjectSummary,
  ordinals: ReadonlyMap<string, number>,
  t: (key: string, values: Record<string, unknown>) => string,
): PanelSection[] {
  const compositions = Object.values(summary.compositions).sort(
    (a: CompositionSummary, b: CompositionSummary) =>
      a.id === summary.root_id ? -1 : b.id === summary.root_id ? 1 : a.ordinal - b.ordinal,
  );
  const asleep: PanelMarker[] = [];
  const sections = compositions.map((c): PanelSection => {
    const awake: PanelMarker[] = [];
    for (const marker of c.markers) {
      const row = { marker, compositionId: c.id, fpsNum: c.fps_num, fpsDen: c.fps_den };
      (marker.hibernating ? asleep : awake).push(row);
    }
    return {
      id: c.id,
      name:
        c.id === summary.root_id
          ? t("dock_workspace.panels.timeline", {})
          : groupDisplayName(c.id, c.label, ordinals, t),
      markers: awake,
    };
  });
  // Last, and OUTSIDE the time ordering, because a hibernating marker has no
  // timeline position: the instant its frozen `t_us` names now holds different
  // content, possibly a different clip, so placing it among the others would be
  // a fabrication. Absent entirely when nothing is asleep — hibernation is a
  // condition, where a composition heading is the project's own structure.
  if (asleep.length > 0) {
    sections.push({ id: HIBERNATING_SECTION, name: t("marker_panel.hibernating", {}), markers: asleep });
  }
  return sections;
}

/// Park the film on a marker, wherever in the project it lives: its own
/// composition first — a seek means nothing on another one — then its time
/// projected up through the anchor that open just gave it. The two steps the
/// search palette already takes for a marker hit; there is one navigation route
/// to a marker, not two.
function activateMarker(row: PanelMarker): void {
  if (
    row.compositionId !== focusedCompositionId() &&
    !openComposition(row.compositionId, null)
  ) {
    return;
  }
  jumpToTimeUs(focusedRootUs(row.marker.t_us));
}

/// One text cell: commits on blur and on Enter, reverts on Escape, and follows
/// the committed value whenever undo/redo or another surface rewrites it. The
/// label and the note differ only in which wrapper they call.
function MarkerTextField({
  value,
  ariaLabel,
  placeholder,
  className,
  onCommit,
}: {
  value: string;
  ariaLabel: string;
  placeholder: string;
  className: string;
  onCommit: (next: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  // Set by Escape so the blur that follows the revert commits nothing; cleared
  // by the next keystroke, which is a fresh edit.
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  return (
    <AppInput
      value={draft}
      onValueChange={(next) => {
        cancelled.current = false;
        setDraft(next);
      }}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      className={className}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onCancel={() => {
        cancelled.current = true;
        setDraft(value);
      }}
      onBlur={() => {
        if (cancelled.current) {
          cancelled.current = false;
          return;
        }
        // An unchanged write is an actor-level no-op that still costs a round
        // trip; leaving a field untouched must cost nothing at all.
        if (draft === value) return;
        void tryMutate(() => onCommit(draft), "update_marker");
      }}
    />
  );
}

/// The row's delete. No confirm dialog stands in front of it, for the reason
/// `remove_marker` itself gives: the deletion is RECORDED, so it is one undo
/// away — and the Panel must not be stricter about an operation than the lane's
/// own context menu, which deletes on the same terms.
///
/// Present on every row, hibernating included: a hibernating marker is painted
/// on no lane, so the context menu that would otherwise delete it cannot be
/// opened at all. Without this button the only marker that CANNOT be deleted is
/// the one whose clip stopped showing it — the exact case a Panel-only surface
/// exists for.
///
/// Hidden until the row is hovered or the button itself takes focus — the house
/// pattern for a row action (`.playhead-goto`). A column of trash cans standing
/// down a dense list reads as the Panel's subject, and the subject is the notes.
function MarkerDeleteButton({ markerId }: { markerId: string }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      title={t("marker_panel.delete")}
      aria-label={t("marker_panel.delete")}
      className="shrink-0 cursor-pointer rounded-[4px] p-[3px] text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
      onClick={() => {
        void tryMutate(() => removeMarker(markerId), "remove_marker");
      }}
    >
      <Trash2 size={12} aria-hidden />
    </button>
  );
}

/// The colour swatch, drafted locally and committed once the gesture goes quiet
/// (`COLOR_COMMIT_QUIET_MS`).
function MarkerColorField({ marker }: { marker: MarkerSummary }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <AppColorField
      value={draft ?? marker.color_hint}
      ariaLabel={t("marker_panel.color_field")}
      // A dot, not the default 32x22 slab: at `TOOL_MINIMUM`'s 240px the slab
      // spends a twelfth of the row on a control whose job HERE is to be read
      // down a column, not aimed at. The modifier lives in `controls.css`
      // because rounding the native swatch needs `::-webkit-color-swatch`,
      // which no utility class can reach.
      className="app-color-swatch--dot"
      withEyeDropper={false}
      onValueChange={(hex) => {
        setDraft(hex);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          // Drop the draft in the same tick the commit is issued: the summary
          // that comes back is what the swatch reads from then on.
          setDraft(null);
          void tryMutate(
            () => setMarkerColor(marker.id, hexToRgba(hex, OPAQUE)),
            "update_marker",
          );
        }, COLOR_COMMIT_QUIET_MS);
      }}
    />
  );
}

/// One row, as a flat card. A step of surface (`--surface-raised` on the
/// Panel's `--card`) plus the list's own gap is the WHOLE separation mechanism —
/// no border, no left colour rail, no shadow. A rail would spend a second
/// channel on the colour the dot already carries, and a lifted card in a list
/// this dense reads as N objects competing rather than N members of a section.
///
/// The hover step is `--accent` rather than `--secondary`: the card already sits
/// one surface above the panel, and `--secondary` is only one step further, so
/// on a raised ground it barely registers as "the pointer is here".
const CARD_ROW =
  "group flex flex-col gap-0.5 rounded-[4px] bg-surface-raised px-2 py-1.5 hover:bg-accent";

/// Line 2 — the note — inset so it lines up with line 1 on both sides.
///
/// Left `15px`: the colour dot (11px) plus the row's `gap-1`, so the note hangs
/// under the TIMECODE. Two lines sharing a left edge read as one block; a note
/// starting at the card's own padding edge reads as a second row.
///
/// Right `22px`: the delete button (a 12px glyph in 3px of padding) plus its
/// gap. Line 1 gives that width up to the action, so line 2 gives it back
/// instead of running on underneath a control — the row ends with one action
/// gutter that both lines respect.
///
/// One caveat, stated rather than worked around: on a HIBERNATING row line 1
/// also carries Detach, so the label ends earlier still and the note lines up
/// with the delete button rather than with the label. The gutter is a constant,
/// and a label whose right edge depends on the width of a translated verb is not
/// something a margin can track.
const NOTE_INSET = "ml-[15px] mr-[22px]";

/// An empty note costs no height until the row is engaged. `group-focus-within`
/// is not decoration here: the field is `display: none` at rest, so without it
/// the note of an unannotated marker could not be reached by keyboard at all —
/// focusing anything else in the row is what puts it back in the tab order.
///
/// The cost is a reflow: hovering a note-less row grows it, and the rows below
/// step down. Dropping `group-hover` and keeping only `group-focus-within`
/// removes that entirely, at the price of the note appearing only once a field
/// in the row is focused.
const NOTE_COLLAPSED = `${NOTE_INSET} hidden group-hover:block group-focus-within:block`;

function MarkerNoteRow({ marker }: { marker: MarkerSummary }) {
  const { t } = useTranslation();
  return (
    <div className={marker.note === "" ? NOTE_COLLAPSED : NOTE_INSET}>
      <MarkerTextField
        className="min-w-0"
        value={marker.note}
        ariaLabel={t("marker_panel.note_field")}
        placeholder={t("marker_panel.note_field")}
        onCommit={(next) => setMarkerNote(marker.id, next)}
      />
    </div>
  );
}

/// A marker sitting on a timeline: its own composition's timecode activates it,
/// and an anchored one is marked as such so "why did this move" has an answer on
/// the row.
function TimelineMarkerRow({ row }: { row: PanelMarker }) {
  const { t } = useTranslation();
  const { marker } = row;
  const timecode = formatTimecode(marker.t_us, row.fpsNum, row.fpsDen);
  return (
    <li className={CARD_ROW}>
      <div className="flex items-center gap-1">
        <MarkerColorField marker={marker} />
        <button
          type="button"
          className="shrink-0 cursor-pointer font-mono text-[11px] text-muted-foreground hover:text-foreground"
          title={t("marker_panel.go_to", { timecode })}
          aria-label={t("marker_panel.go_to", { timecode })}
          onClick={() => activateMarker(row)}
        >
          {timecode}
        </button>
        {marker.anchor_layer !== null && (
          <span
            role="img"
            aria-label={t("marker_panel.anchored")}
            title={t("marker_panel.anchored")}
            className="shrink-0 text-muted-foreground"
          >
            <Anchor size={11} />
          </span>
        )}
        <MarkerTextField
          className="min-w-0 flex-1"
          value={marker.label}
          ariaLabel={t("marker_panel.label_field")}
          placeholder={t("kinds.marker")}
          onCommit={(next) => renameMarker(marker.id, next)}
        />
        <MarkerDeleteButton markerId={marker.id} />
      </div>
      <MarkerNoteRow marker={marker} />
    </li>
  );
}

/// A marker whose clip no longer shows the frame it names. It has no timeline
/// position to offer, so the row offers the two things that are still true: the
/// position INSIDE THE MEDIA, and the clip that mark is in — "this mark is in
/// this footage, but you are not using that part right now."
///
/// Detach is the row's one action and the one exit from hibernation, for the
/// case where the note is worth keeping but the following is not.
function HibernatingMarkerRow({ row }: { row: PanelMarker }) {
  const { t } = useTranslation();
  const { marker } = row;
  const ordinals = useGroupOrdinals();
  const layer = useProjectStore((s) =>
    marker.anchor_layer === null ? undefined : s.layerById.get(marker.anchor_layer),
  );
  // Wall clock rather than a timecode: this is a position in the footage, and
  // the composition's frame rate — the only rate the summary carries here — is
  // not the rate that footage was shot at, so counting frames in it would be a
  // number nobody could act on.
  //
  // Hibernation implies an anchor, so `anchor_src_us` is present on every row
  // that reaches here; the fallback only covers the window between a mutation
  // and the commit that rejects it.
  const source = formatWallClock(marker.anchor_src_us ?? marker.t_us);
  return (
    <li className={CARD_ROW}>
      <div className="flex items-center gap-1">
        <MarkerColorField marker={marker} />
        <button
          type="button"
          className="shrink-0 cursor-pointer font-mono text-[11px] text-muted-foreground hover:text-foreground"
          title={t("marker_panel.reveal_clip", { timecode: source })}
          aria-label={t("marker_panel.reveal_clip", { timecode: source })}
          onClick={() => {
            if (marker.anchor_layer !== null) jumpToLayer(marker.anchor_layer);
          }}
        >
          {source}
        </button>
        {layer && (
          <span className="min-w-0 shrink truncate text-[11px] text-muted-foreground">
            {layerDisplayName(layer, t, ordinals)}
          </span>
        )}
        <MarkerTextField
          className="min-w-0 flex-1"
          value={marker.label}
          ariaLabel={t("marker_panel.label_field")}
          placeholder={t("kinds.marker")}
          onCommit={(next) => renameMarker(marker.id, next)}
        />
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded-[4px] px-1 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => {
            void tryMutate(() => detachMarker(marker.id), "detach_marker");
          }}
        >
          {t("marker_panel.detach")}
        </button>
        <MarkerDeleteButton markerId={marker.id} />
      </div>
      <MarkerNoteRow marker={marker} />
    </li>
  );
}

/// One heading plus its rows. A section with no markers keeps its heading and
/// loses its disclosure: `(0)` is the answer to "what is marked here", and there
/// is nothing behind it to fold away.
function MarkerSectionView({
  section,
  collapsed,
  onToggle,
}: {
  section: PanelSection;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const heading = t("marker_panel.section_heading", {
    name: section.name,
    count: section.markers.length,
  });
  return (
    <section aria-label={section.name} className="flex flex-col">
      {section.markers.length === 0 ? (
        <h3 className="px-0.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
          {heading}
        </h3>
      ) : (
        <h3>
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={onToggle}
            className="flex w-full cursor-pointer items-center gap-1 px-0.5 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground hover:text-foreground"
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            {heading}
          </button>
        </h3>
      )}
      {!collapsed && section.markers.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {section.markers.map((row) =>
            row.marker.hibernating ? (
              <HibernatingMarkerRow key={row.marker.id} row={row} />
            ) : (
              <TimelineMarkerRow key={row.marker.id} row={row} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

export function MarkerPanel() {
  const { t } = useTranslation();
  const summary = useProjectSummary();
  const ordinals = useGroupOrdinals();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const sections = useMemo(
    () => (summary ? buildSections(summary, ordinals, t) : []),
    [summary, ordinals, t],
  );
  return (
    <section
      // Real side padding, replacing `p-1`'s 4px: the cards need a margin to sit
      // in, or their own surface runs into the panel edge and the step of
      // surface stops reading as a card at all.
      className="flex flex-col gap-3.5 px-2 pt-1 pb-2"
      aria-label={t("dock_workspace.panels.marker")}
      data-testid="marker-panel"
    >
      {sections.map((section) => (
        <MarkerSectionView
          key={section.id}
          section={section}
          collapsed={collapsed.has(section.id)}
          onToggle={() =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (!next.delete(section.id)) next.add(section.id);
              return next;
            })
          }
        />
      ))}
    </section>
  );
}
