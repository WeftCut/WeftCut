// Two-tier easing UI for the selected keyframes' outgoing segments, anchored at
// the right-click point. Tier 1 is a Base UI Menu mirroring the mainstream-NLE
// keyframe menu (Premiere ships seven items, Resolve four): the five everyday
// interpolations plus Smooth, checkmarked via the exact reverse lookup, and —
// on a track's first or last key — the Extrapolate before / after submenus.
// The full canonical table — the differentiation feature — lives behind
// "Easing library…" as Tier 2, a Popover (a wall of curve thumbnails and two
// sliders is not a menu): a family-grouped gallery of engine-sampled curve
// thumbnails. Arming any row of either tier previews it live on EVERY selected
// group through `easingPreviewStore`; both tiers close through the one
// `onClose`, so outside-press / Escape behave identically in either. In-place
// tangent-handle editing lives in KeyframeCurveGraph.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { AnimTrack, Extrapolate, Interpolation, Keyframe } from "../ipc";
import {
  EASING_PRESETS,
  applySegmentEasing,
  presetIdForInterp,
  segmentEasing,
  type EasingPreset,
  type EasingPresetId,
} from "../../shared/easing";
import { HOLD_EXTRAPOLATION, IN_IDENTITY, inIdentity, outIdentity } from "../../shared/keyframe";
import { solveAutoTangents } from "../../shared/tangents";
import { useKeyframeSelectionStore } from "../keyframe/selectionStore";
import {
  IDENTITY_EDIT,
  applySegmentEasingKeys,
  selectedKeysOf,
  setAutoKeys,
  setExtrapolationKeys,
  useKeyframeBatchFold,
  type KeyframeGroupEdit,
  type ParamTrackEntry,
} from "./keyframeBatch";
import { clearTrackPreview, setTrackPreviews } from "../keyframe/easingPreviewStore";
import { EXTRAPOLATE_MODES, extrapolateLabelKey, isSplineInterp } from "../keyframe/curve";
import { computeValueRange, segmentPolyline, type CurveGeom } from "../keyframe/curveGraph";
import { AppSlider } from "../components/AppSlider";
import {
  MenuItem,
  MenuSeparator,
  SubMenu,
  closeContextMenuOn,
  contextMenuFinalFocus,
} from "../menu/Menu";
import { useCursorAnchor } from "./contextMenuAnchor";

/// Tier-1 command set — the presets a stock NLE puts on the keyframe itself.
/// Everything else is reachable only through the gallery.
const COMMAND_IDS = ["linear", "hold", "ease_in", "ease_out", "ease_in_out"] as const;
const COMMAND_ID_SET: ReadonlySet<EasingPresetId> = new Set(COMMAND_IDS);

/// The classic group heads the gallery (table order: linear, hold, and the
/// CSS-named eases); every other id's family is its last `_` segment.
const CLASSIC_IDS = new Set(["linear", "hold", "ease", "ease_in", "ease_out", "ease_in_out"]);

function familyOf(id: string): string {
  if (CLASSIC_IDS.has(id)) return "classic";
  return /_([a-z]+)$/.exec(id)![1]!;
}

function presetById(id: EasingPresetId): EasingPreset {
  return EASING_PRESETS.find((p) => p.id === id)!;
}

/// Gallery rows, 3 presets per grid row: the classic six chunked in threes,
/// then one row per In/Out/InOut family in canonical table order. Derived,
/// never a second source — reordering the gallery means reordering the table.
const GALLERY_ROWS: { family: string; labelled: boolean; presets: EasingPreset[] }[] = (() => {
  const classic = EASING_PRESETS.filter((p) => CLASSIC_IDS.has(p.id));
  const rows = [
    { family: "classic", labelled: true, presets: classic.slice(0, 3) },
    { family: "classic", labelled: false, presets: classic.slice(3) },
  ];
  for (const p of EASING_PRESETS) {
    if (CLASSIC_IDS.has(p.id)) continue;
    const fam = familyOf(p.id);
    const last = rows[rows.length - 1]!;
    if (last.family === fam) last.presets.push(p);
    else rows.push({ family: fam, labelled: true, presets: [p] });
  }
  return rows;
})();

const THUMB_W = 44;
const THUMB_H = 26;

/// Thumbnail polylines, cached per preset id: the table is append-only and the
/// geometry constants are fixed, so a curve never changes within a session.
/// Sampled through the SAME wasm eval the timeline curve uses (segmentPolyline
/// → resolveAnimated), so a thumbnail shows exactly what the engine computes —
/// overshoot included via computeValueRange. Computed lazily on first gallery
/// open, safely after the renderer bootstrap awaited initEval().
const thumbCache = new Map<EasingPresetId, string>();
/// A unit segment (0 → 1 over 1 s) carrying `e` — the two keys a preset writes.
function unitSegment(e: Interpolation): [Keyframe<number>, Keyframe<number>] {
  const base = (id: string, t_us: number, value: number): Keyframe<number> => ({
    id, t_us, value, in: inIdentity(), out: outIdentity(), continuity: "Broken", segment: { kind: "Linear" },
  });
  const [a, b] = applySegmentEasing(base("a", 0, 0), base("b", 1_000_000, 1), e);
  return [a, b!];
}
function thumbPoints(p: EasingPreset): string {
  const hit = thumbCache.get(p.id);
  if (hit) return hit;
  const [a, b] = unitSegment(p.interp);
  const { vmin, vmax } = computeValueRange([a, b]);
  const g: CurveGeom = { pxPerSec: THUMB_W, layerTStartUs: 0, height: THUMB_H, vmin, vmax };
  const pts = segmentPolyline(
    { aTUs: a.t_us, aVal: a.value, bTUs: b.t_us, bVal: b.value },
    a,
    b,
    g,
    32,
  )
    .map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    .join(" ");
  thumbCache.set(p.id, pts);
  return pts;
}

const THUMB_STYLE: React.CSSProperties = {
  display: "block",
  padding: "2px",
  borderRadius: "var(--radius-control)",
  border: "1px solid var(--border, #3f3f46)",
  background: "var(--secondary, #27272a)",
  cursor: "pointer",
  lineHeight: 0,
};

/// The reverse-lookup match — the one thumbnail painted as selected.
const THUMB_SELECTED_STYLE: React.CSSProperties = {
  ...THUMB_STYLE,
  border: "1px solid var(--selection-border, #3b82f6)",
  background: "var(--selection-bg, rgba(59,130,246,0.16))",
};

const ROW_LABEL_STYLE: React.CSSProperties = {
  fontSize: "var(--font-size-caption)",
  color: "var(--muted-foreground, #9ca3af)",
  paddingRight: "2px",
  whiteSpace: "nowrap",
};

/// Shows `edit`'s result on every selected group while a row is armed, or
/// clears (`null`).
type PreviewEdit = (edit: KeyframeGroupEdit | null) => void;

/// The preview an armed row shows: the batch fold of the row's edit over every
/// selected group, run through the same write-time solver main applies
/// (`solveAutoTangents`) so an Auto mark previews as the curve that will be
/// stored, and written to `easingPreviewStore` for as long as the row is
/// armed. One gesture at a time — arming a row replaces whatever the previous
/// one set — and whatever this menu set is cleared when it unmounts, so a
/// preview never outlives the menu that raised it, nor wipes one a newer menu
/// on another selection has claimed.
function usePreviewEdit(): PreviewEdit {
  const fold = useKeyframeBatchFold();
  const setRef = useRef<[layerId: string, paramKey: string][]>([]);
  const preview = useCallback<PreviewEdit>(
    (edit) => {
      for (const [layerId, paramKey] of setRef.current) clearTrackPreview(layerId, paramKey);
      setRef.current = [];
      if (edit === null) return;
      const entries = fold(edit).map(solvedEntry);
      setTrackPreviews(entries);
      setRef.current = entries.map(([layerId, paramKey]) => [layerId, paramKey]);
    },
    [fold],
  );
  useEffect(() => () => preview(null), [preview]);
  return preview;
}

/// One folded entry with its Auto / Smooth sides solved the way main's write
/// normalization will solve them; a colour track has no scalar to solve on.
function solvedEntry(entry: ParamTrackEntry): ParamTrackEntry {
  const [layerId, paramKey, track] = entry;
  if (track.mode !== "Keyframed") return entry;
  const numeric = track.value.every((k) => typeof k.value === "number");
  const value = solveAutoTangents(
    track.value,
    numeric ? (v) => v as number : null,
  );
  return [layerId, paramKey, { ...track, value }];
}

/// One gallery thumbnail. Hover/focus previews the preset on every selected
/// group (the same path a slider drags through); leaving clears it, clicking
/// commits and closes. The name rides on aria-label/title, so the grid stays a
/// wall of curves, not of words.
function PresetThumb({
  preset,
  selected,
  onPreview,
  onApply,
}: {
  preset: EasingPreset;
  selected: boolean;
  onPreview: (interp: Interpolation | null) => void;
  onApply: (interp: Interpolation) => void;
}) {
  const { t } = useTranslation();
  const label = t(preset.labelKey);
  const procedural = !isSplineInterp(preset.interp);
  return (
    <button
      type="button"
      data-testid="easing-preset-chip"
      aria-pressed={selected}
      aria-label={label}
      title={label}
      style={selected ? THUMB_SELECTED_STYLE : THUMB_STYLE}
      onClick={() => onApply(preset.interp)}
      onMouseEnter={() => onPreview(preset.interp)}
      onMouseLeave={() => onPreview(null)}
      onFocus={() => onPreview(preset.interp)}
      onBlur={() => onPreview(null)}
    >
      <svg width={THUMB_W} height={THUMB_H} viewBox={`0 0 ${THUMB_W} ${THUMB_H}`} aria-hidden>
        <polyline
          points={thumbPoints(preset)}
          fill="none"
          // Same stroke split as the curve graph: --keyframe tints the
          // procedural (parameter-curve) kinds, --ring the spline kinds.
          stroke={procedural ? "var(--keyframe, #facc15)" : "var(--ring, #9a9aff)"}
          strokeWidth={1.5}
        />
      </svg>
    </button>
  );
}

/// Elastic slider ranges. The 1.0 amplitude floor is the schema/engine
/// contract (the engine's phase needs `asin(1/a)` to exist). The ceilings are
/// UI choices: past ~4× amplitude the overshoot dwarfs the segment, and past a
/// 2.0 period less than half an oscillation fits — both defaults (1.0 / 0.3)
/// sit comfortably inside.
const AMPLITUDE_MIN = 1.0;
const AMPLITUDE_MAX = 4.0;
const PERIOD_MIN = 0.05;
const PERIOD_MAX = 2.0;
const PARAM_STEP = 0.05;

const PARAM_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  fontSize: "var(--font-size-caption)",
  color: "var(--muted-foreground, #9ca3af)",
};

/// Amplitude/period sliders for an Elastic keyframe. All three params are
/// pinned at mount and advanced ONLY by drag-local state: every commit is a
/// complete Elastic interp built from that state, never base+delta read back
/// from the track prop — the renderer mirror lags commits by up to two round
/// trips, and a read-modify-write from it eats the previous commit (see
/// feedback_renderer_mirror_read_modify_write). Live redraw goes through the
/// preview; the actor commit fires once per gesture on release, matching the
/// tangent-handle undo convention.
function ElasticParamRows({
  interp,
  onPreview,
  onCommitInterp,
}: {
  interp: Extract<Interpolation, { kind: "Elastic" }>;
  onPreview: (interp: Interpolation | null) => void;
  onCommitInterp: (interp: Interpolation) => void;
}) {
  const { t } = useTranslation();
  const [dir] = useState(interp.dir);
  const [amplitude, setAmplitude] = useState(interp.amplitude);
  const [period, setPeriod] = useState(interp.period);

  const build = (a: number, p: number): Interpolation => ({
    kind: "Elastic",
    dir,
    amplitude: a,
    period: p,
  });

  return (
    <div
      data-testid="easing-elastic-params"
      style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "2px 0" }}
    >
      <div style={PARAM_ROW_STYLE}>
        <span style={{ width: "48px", flexShrink: 0 }}>{t("keyframe.elastic_amplitude")}</span>
        <AppSlider
          value={amplitude}
          min={AMPLITUDE_MIN}
          max={AMPLITUDE_MAX}
          step={PARAM_STEP}
          ariaLabel={t("keyframe.elastic_amplitude")}
          onValueChange={(v) => {
            setAmplitude(v);
            onPreview(build(v, period));
          }}
          onValueCommitted={(v) => {
            setAmplitude(v);
            onCommitInterp(build(v, period));
          }}
        />
        <span style={{ width: "32px", textAlign: "right" }}>{amplitude.toFixed(2)}</span>
      </div>
      <div style={PARAM_ROW_STYLE}>
        <span style={{ width: "48px", flexShrink: 0 }}>{t("keyframe.elastic_period")}</span>
        <AppSlider
          value={period}
          min={PERIOD_MIN}
          max={PERIOD_MAX}
          step={PARAM_STEP}
          ariaLabel={t("keyframe.elastic_period")}
          onValueChange={(v) => {
            setPeriod(v);
            onPreview(build(amplitude, v));
          }}
          onValueCommitted={(v) => {
            setPeriod(v);
            onCommitInterp(build(amplitude, v));
          }}
        />
        <span style={{ width: "32px", textAlign: "right" }}>{period.toFixed(2)}</span>
      </div>
    </div>
  );
}

/// The easing of the segment LEAVING `kfId`, as the menu reads it. The last key
/// has no such segment: its stored class is still reported (so a Hold last key
/// keeps Smooth disabled), with the identity arriving side standing in for a
/// Spline — there is no right key to read one from.
function easingLeaving(keys: readonly Keyframe<number>[], kfId: string): Interpolation {
  const i = keys.findIndex((k) => k.id === kfId);
  const k = keys[i];
  if (!k) return { kind: "Linear" };
  const next = keys[i + 1];
  if (next) return segmentEasing(k, next);
  if (k.segment.kind === "Spline") {
    return { kind: "Bezier", p1: [k.out.x, k.out.y], p2: [IN_IDENTITY.x, IN_IDENTITY.y] };
  }
  return segmentEasing(k, k);
}

/// The five modes for one side of the track, radio-checkmarked at the current
/// one. Arming a mode previews the track under it (the curve graph draws the
/// tails from the previewed track's own `extrapolate`).
function ExtrapolateSubMenu({
  side,
  current,
  onArm,
  onPick,
}: {
  side: "before" | "after";
  current: Extrapolate;
  onArm: PreviewEdit;
  onPick: (mode: Extrapolate) => void;
}) {
  const { t } = useTranslation();
  const patchFor = (mode: Extrapolate) => (side === "before" ? { before: mode } : { after: mode });
  return (
    <SubMenu label={t(`keyframe.extrapolate_${side}`)}>
      {EXTRAPOLATE_MODES.map((mode) => (
        <MenuItem
          key={mode}
          testId={`easing-extrap-${side}-${mode}`}
          label={t(extrapolateLabelKey(mode))}
          checked={current === mode}
          onArmedChange={(armed) => onArm(armed ? setExtrapolationKeys(patchFor(mode)) : null)}
          onSelect={() => onPick(mode)}
        />
      ))}
    </SubMenu>
  );
}

export function EasingMenu({
  x, y, track, kfId, onApply, onClose,
}: {
  x: number;
  y: number;
  /// The right-clicked key and its own track — what the menu READS for the
  /// single-key answers: the checkmark's reverse lookup, the Elastic sliders'
  /// pinned params, whether this key is the track's first or last and the
  /// track's extrapolation. Writes never go through it, and the whole
  /// selection is read through the batch fold.
  track: AnimTrack<number>;
  kfId: string;
  /// Applies the chosen edit to EVERY selected key, folded per
  /// (layerId, paramKey) into one commit (`keyframeBatch.ts`).
  onApply: (edit: KeyframeGroupEdit) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<"commands" | "gallery">("commands");
  const selected = useKeyframeSelectionStore((s) => s.selected);
  // A selection of more than one key has no single current interpolation, so the
  // menu reports none: no checkmark and no Elastic sliders (those tune ONE key's
  // params). Showing the right-clicked key's would claim the rest match it, and
  // nothing on screen would let the user see through that. The cost is that a
  // uniform multi-key selection is under-reported — the safe direction. Smooth
  // stays offered: it is a per-key operation, and a Hold among the selection is
  // converted the way a gallery preset would convert it.
  const mixed = selected.size > 1;
  const current: Interpolation | null = mixed
    ? null
    : track.mode === "Keyframed"
      ? easingLeaving(track.value, kfId)
      : { kind: "Linear" as const };
  const isHold = current?.kind === "Hold";
  // Which entry the current params ARE (display-layer identity): exact reverse
  // lookup, so a hand-dragged bezier or tuned Elastic selects nothing.
  const selectedId = current === null ? undefined : presetIdForInterp(current);
  // A gallery-only preset checkmarks the library row itself — the menu still
  // answers "what is this keyframe" without opening Tier 2.
  const selectionInGallery = selectedId !== undefined && !COMMAND_ID_SET.has(selectedId);

  const fold = useKeyframeBatchFold();
  const preview = usePreviewEdit();

  // Smooth means Auto, and Auto is per key, so its checkmark CAN speak for a
  // multi-key selection: checked when every selected key has an Auto side. The
  // fold with no edit is where the selection's committed keys are readable.
  const selectionKeys = fold(IDENTITY_EDIT).flatMap((entry) =>
    selectedKeysOf(entry, [...selected.values()]),
  );
  const autoChecked =
    selectionKeys.length > 0 &&
    selectionKeys.every((k) => k.in.mode === "Auto" || k.out.mode === "Auto");

  // Extrapolation is a track-level pair, offered where it applies: on the
  // track's first key (before) and last key (after), one key at a time — a
  // multi-key selection has no single track to speak for.
  const keys = track.mode === "Keyframed" ? track.value : [];
  const at = keys.findIndex((k) => k.id === kfId);
  const showBefore = !mixed && at === 0;
  const showAfter = !mixed && at >= 0 && at === keys.length - 1;
  const extrapolate = track.mode === "Keyframed" ? track.extrapolate : HOLD_EXTRAPOLATION;

  const anchor = useCursorAnchor(x, y);

  // Set by a tier-1 commit, which closes the menu: on its way out Base UI still
  // moves focus onto the pressed row, and that focus would re-arm the preview
  // the commit just dropped. Nothing arms after a commit.
  const closingRef = useRef(false);
  const arm: PreviewEdit = (edit) => {
    if (edit !== null && closingRef.current) return;
    preview(edit);
  };
  const commit = (edit: KeyframeGroupEdit) => {
    // A commit replaces any armed preview outright — drop it so the committed
    // track is what the curve shows while the actor round-trip is in flight.
    closingRef.current = true;
    preview(null);
    onApply(edit);
    onClose();
  };
  const applyToSelection = (interp: Interpolation) => commit(applySegmentEasingKeys(interp));
  const armRow = (edit: KeyframeGroupEdit) => (armed: boolean) => arm(armed ? edit : null);

  if (view === "commands") {
    return (
      <MenuPrimitive.Root
        open
        modal={false}
        // Holds submenus — see the LANDMINE on `SubMenu` in `menu/Menu.tsx`.
        highlightItemOnHover={false}
        onOpenChange={closeContextMenuOn(onClose)}
      >
        <MenuPrimitive.Portal>
          <MenuPrimitive.Positioner
            anchor={anchor}
            side="bottom"
            align="start"
            sideOffset={4}
            className="app-popup-positioner"
          >
            <MenuPrimitive.Popup
              className="app-menu-list easing-command-menu"
              data-testid="easing-command-menu"
              finalFocus={contextMenuFinalFocus}
            >
              {COMMAND_IDS.map((id) => {
                const p = presetById(id);
                return (
                  <MenuItem
                    key={id}
                    testId={`easing-cmd-${id}`}
                    label={t(p.labelKey)}
                    checked={selectedId === id}
                    onArmedChange={armRow(applySegmentEasingKeys(p.interp))}
                    onSelect={() => applyToSelection(p.interp)}
                  />
                );
              })}
              <MenuItem
                testId="easing-smooth"
                label={t("keyframe.smooth")}
                disabled={isHold}
                checked={autoChecked}
                {...(isHold ? {} : { onArmedChange: armRow(setAutoKeys) })}
                onSelect={() => commit(setAutoKeys)}
              />
              {(showBefore || showAfter) && <MenuSeparator />}
              {showBefore && (
                <ExtrapolateSubMenu
                  side="before"
                  current={extrapolate.before}
                  onArm={arm}
                  onPick={(mode) => commit(setExtrapolationKeys({ before: mode }))}
                />
              )}
              {showAfter && (
                <ExtrapolateSubMenu
                  side="after"
                  current={extrapolate.after}
                  onArm={arm}
                  onPick={(mode) => commit(setExtrapolationKeys({ after: mode }))}
                />
              )}
              <MenuSeparator />
              <MenuItem
                testId="easing-open-gallery"
                label={t("keyframe.easing_library")}
                checked={selectionInGallery}
                closeOnClick={false}
                onSelect={() => setView("gallery")}
              />
            </MenuPrimitive.Popup>
          </MenuPrimitive.Positioner>
        </MenuPrimitive.Portal>
      </MenuPrimitive.Root>
    );
  }

  return (
    <PopoverPrimitive.Root open modal={false} onOpenChange={(o) => { if (!o) onClose(); }}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={4}
          className="app-popup-positioner"
        >
          <PopoverPrimitive.Popup
            className="app-menu-list"
            data-testid="easing-gallery"
            style={{
              padding: "6px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              width: "244px",
              maxHeight: "380px",
              overflowY: "auto",
            }}
          >
            {current !== null && current.kind === "Elastic" && (
              <ElasticParamRows
                interp={current}
                onPreview={(interp) => preview(interp ? applySegmentEasingKeys(interp) : null)}
                // Full interp from the sliders' drag-local state; the popover
                // stays open so a gesture on the other slider can follow.
                onCommitInterp={(interp) => {
                  preview(null);
                  onApply(applySegmentEasingKeys(interp));
                }}
              />
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "44px repeat(3, 1fr)",
                gap: "4px",
                alignItems: "center",
                justifyItems: "start",
              }}
            >
              {GALLERY_ROWS.map((row, i) => (
                <div key={i} style={{ display: "contents" }}>
                  <span style={ROW_LABEL_STYLE}>
                    {row.labelled ? t(`keyframe.family_${row.family}`) : ""}
                  </span>
                  {row.presets.map((p) => (
                    <PresetThumb
                      key={p.id}
                      preset={p}
                      selected={p.id === selectedId}
                      onPreview={(interp) => preview(interp ? applySegmentEasingKeys(interp) : null)}
                      onApply={applyToSelection}
                    />
                  ))}
                </div>
              ))}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
