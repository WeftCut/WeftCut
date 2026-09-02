// Two-tier easing UI for the selected keyframes' outgoing segments, anchored at
// the right-click point. Tier 1 mirrors the mainstream-NLE keyframe menu (Premiere
// ships seven items, Resolve four): the five everyday interpolations plus
// Smooth, checkmarked via the exact reverse lookup. The full canonical table —
// the differentiation feature — lives behind "Easing library…" as Tier 2: a
// family-grouped gallery of engine-sampled curve thumbnails where hovering a
// preset live-previews it on the timeline curve. One Popover hosts both views
// (view swap, not a second popup), so outside-press/Escape behave identically
// in either tier. In-place tangent-handle editing lives in KeyframeCurveGraph.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { AnimTrack, Interpolation, Keyframe } from "../ipc";
import {
  EASING_PRESETS,
  applySegmentEasing,
  presetIdForInterp,
  segmentEasing,
  type EasingPreset,
  type EasingPresetId,
} from "../../shared/easing";
import { IN_IDENTITY, inIdentity, outIdentity } from "../../shared/keyframe";
import { useKeyframeSelectionStore } from "../keyframe/selectionStore";
import { applySegmentEasingKeys, setAutoKeys, type KeyframeGroupEdit } from "./keyframeBatch";
import { clearEasingPreview, setEasingPreview } from "../keyframe/easingPreviewStore";
import { isSplineInterp } from "../keyframe/curve";
import { computeValueRange, segmentPolyline, type CurveGeom } from "../keyframe/curveGraph";
import { AppSlider } from "../components/AppSlider";

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

/// One gallery thumbnail. Hover/focus previews the preset on the live timeline
/// curve (easingPreviewStore — the same bridge the Elastic sliders drag
/// through); leaving clears it, clicking commits and closes. The name rides on
/// aria-label/title, so the grid stays a wall of curves, not of words.
function PresetThumb({
  preset,
  selected,
  kfId,
  onApply,
}: {
  preset: EasingPreset;
  selected: boolean;
  kfId: string;
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
      onClick={() => {
        // A preset replaces any hover/slider draft outright — drop the preview
        // so the gallery commit is what the curve shows.
        clearEasingPreview(kfId);
        onApply(preset.interp);
      }}
      onMouseEnter={() => setEasingPreview(kfId, preset.interp)}
      onMouseLeave={() => clearEasingPreview(kfId)}
      onFocus={() => setEasingPreview(kfId, preset.interp)}
      onBlur={() => clearEasingPreview(kfId)}
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
/// feedback_renderer_mirror_read_modify_write). Live redraw goes through
/// easingPreviewStore; the actor commit fires once per gesture on release,
/// matching the tangent-handle undo convention.
function ElasticParamRows({
  kfId,
  interp,
  onCommitInterp,
}: {
  kfId: string;
  interp: Extract<Interpolation, { kind: "Elastic" }>;
  onCommitInterp: (interp: Interpolation) => void;
}) {
  const { t } = useTranslation();
  const [dir] = useState(interp.dir);
  const [amplitude, setAmplitude] = useState(interp.amplitude);
  const [period, setPeriod] = useState(interp.period);
  // Whatever the gesture state, the preview must not outlive the menu.
  useEffect(() => () => clearEasingPreview(kfId), [kfId]);

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
            setEasingPreview(kfId, build(v, period));
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
            setEasingPreview(kfId, build(amplitude, v));
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

export function EasingMenu({
  x, y, track, kfId, onApply, onClose,
}: {
  x: number;
  y: number;
  /// The right-clicked key and its own track — what the menu READS: the
  /// checkmark's reverse lookup, the Elastic sliders' pinned params, and the
  /// hover preview's scope. Writes never go through it. `easingPreviewStore`
  /// holds ONE key, so a hover previews on this key alone however many are
  /// selected; the commit still reaches all of them.
  track: AnimTrack<number>;
  kfId: string;
  /// Applies the chosen edit to EVERY selected key, folded per
  /// (layerId, paramKey) into one commit (`keyframeBatch.ts`).
  onApply: (edit: KeyframeGroupEdit) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<"commands" | "gallery">("commands");
  // A selection of more than one key has no single current interpolation, so the
  // menu reports none: no checkmark and no Elastic sliders (those tune ONE key's
  // params). Showing the right-clicked key's would claim the rest match it, and
  // nothing on screen would let the user see through that. The cost is that a
  // uniform multi-key selection is under-reported — the safe direction, and the
  // only one available to a menu that holds a single key's track. Smooth stays
  // offered: it is a per-key operation, and a Hold among the selection is
  // converted the way a gallery preset would convert it.
  const mixed = useKeyframeSelectionStore((s) => s.selected.size) > 1;
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

  // A hover preview must not outlive the menu (scoped: never wipes a preview a
  // newer menu on another keyframe has already claimed).
  useEffect(() => () => clearEasingPreview(kfId), [kfId]);

  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () =>
        ({ x, y, top: y, left: x, right: x, bottom: y, width: 0, height: 0 }) as DOMRect,
    }),
    [x, y],
  );

  const applyToSelection = (interp: Interpolation) => {
    onApply(applySegmentEasingKeys(interp));
    onClose();
  };

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
          {view === "commands" ? (
            <PopoverPrimitive.Popup
              className="app-menu-list easing-command-menu"
              data-testid="easing-command-menu"
            >
              {COMMAND_IDS.map((id) => {
                const p = presetById(id);
                return (
                  <button
                    key={id}
                    type="button"
                    className="app-menu-item"
                    data-testid={`easing-cmd-${id}`}
                    onClick={() => applyToSelection(p.interp)}
                  >
                    <span className="app-menu-item-check" aria-hidden>
                      {selectedId === id ? "✓" : ""}
                    </span>
                    <span className="app-menu-item-label">{t(p.labelKey)}</span>
                  </button>
                );
              })}
              <button
                type="button"
                className="app-menu-item"
                data-testid="easing-smooth"
                disabled={isHold}
                {...(isHold ? { "data-disabled": "" } : {})}
                onClick={() => { onApply(setAutoKeys); onClose(); }}
              >
                <span className="app-menu-item-check" aria-hidden />
                <span className="app-menu-item-label">{t("keyframe.smooth")}</span>
              </button>
              <div className="menu-separator" />
              <button
                type="button"
                className="app-menu-item"
                data-testid="easing-open-gallery"
                onClick={() => setView("gallery")}
              >
                <span className="app-menu-item-check" aria-hidden>
                  {selectionInGallery ? "✓" : ""}
                </span>
                <span className="app-menu-item-label">{t("keyframe.easing_library")}</span>
              </button>
            </PopoverPrimitive.Popup>
          ) : (
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
                  kfId={kfId}
                  interp={current}
                  // Full interp from the sliders' drag-local state; the popover
                  // stays open so a gesture on the other slider can follow.
                  onCommitInterp={(interp) => onApply(applySegmentEasingKeys(interp))}
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
                        kfId={kfId}
                        onApply={applyToSelection}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </PopoverPrimitive.Popup>
          )}
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
