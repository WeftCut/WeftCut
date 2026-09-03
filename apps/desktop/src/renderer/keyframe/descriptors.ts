// The frontend mirror of main's `f64Lens` / `rgbaLens`
// (src/main/state/mutations/params.ts): which params each layer kind can
// keyframe, in inspector order. The IPC view flattens transform, so
// `params[paramKey]` is that param's `AnimTrack`.
import type { AnimTrack, LayerSummary, Rgba } from "../ipc";

export type KfWidget = "slider" | "number" | "readout";

interface ParamDescriptorBase {
  /// Wire key understood by `updateLayerParamTrack` and main's lenses.
  paramKey: string;
  /// Existing i18n key (reuse the property-panel labels).
  labelKey: string;
  /// Composite marker: commits fan the authored track out to every listed key
  /// (structural twin copies, fresh ids) through the plural batch mutation, so
  /// the whole write is one undo. Reads still come from `paramKey`.
  fanOutKeys?: string[];
}

/// A param whose track carries numbers — every transform axis, opacity, the
/// audio pair, and every effect param.
export interface NumberParamDescriptor extends ParamDescriptorBase {
  valueKind: "number";
  /// Static fallback used when a Keyframed track is empty / before its first key.
  fallback: number;
  /// Number-field / slider step (absent ⇒ default 1).
  step?: number;
  /// Optional domain bounds.
  min?: number;
  max?: number;
  /// Default inspector presentation, rendered in order, all bound to one value.
  /// Consumers (e.g. the timeline) may override per call.
  widgets?: KfWidget[];
}

/// A param whose track carries `Rgba`. There is exactly one — `color` on Text
/// and Color — and it needs none of the numeric arm's widget metadata: a colour
/// is authored by one swatch, has no step and no bounds beyond the channel
/// range the mutation layer enforces.
export interface RgbaParamDescriptor extends ParamDescriptorBase {
  valueKind: "rgba";
  fallback: Rgba;
}

/// Discriminated by `valueKind` so a numeric consumer that reads `fallback`,
/// `step` or `widgets` has to narrow first, rather than silently handing an
/// `Rgba` to a number field.
export type ParamDescriptor = NumberParamDescriptor | RgbaParamDescriptor;

/// A param's track with its value type left open — what a surface handed a
/// param key rather than a descriptor works in. One `AnimTrack` over the value
/// union, not a union of two tracks: the generic edits infer a single `T` from
/// it, so `upsertKeyframe` / `removeKeyframe` stay one call each.
export type ParamTrack = AnimTrack<number | Rgba>;

export const X: NumberParamDescriptor = { valueKind: "number", paramKey: "x", labelKey: "property_panel.x", fallback: 0, step: 1, widgets: ["number"] };
export const Y: NumberParamDescriptor = { valueKind: "number", paramKey: "y", labelKey: "property_panel.y", fallback: 0, step: 1, widgets: ["number"] };
export const SCALE_X: NumberParamDescriptor = { valueKind: "number", paramKey: "scale_x", labelKey: "property_panel.scale_x", fallback: 1, step: 0.05, widgets: ["number"] };
export const SCALE_Y: NumberParamDescriptor = { valueKind: "number", paramKey: "scale_y", labelKey: "property_panel.scale_y", fallback: 1, step: 0.05, widgets: ["number"] };
/// The two keys the composite Scale writes — the single home for the pair
/// (SCALE.fanOutKeys and the timeline's link-aware sink both read it here).
const SCALE_PAIR = ["scale_x", "scale_y"];
/// The collapsed "Scale" a linked layer shows instead of SCALE_X + SCALE_Y.
/// Reads scale_x (linked ⇒ the tracks are twins, either side is truthful);
/// writes fan out to both axes as one batch.
export const SCALE: NumberParamDescriptor = { valueKind: "number", paramKey: "scale_x", labelKey: "property_panel.scale", fallback: 1, step: 0.05, widgets: ["number"], fanOutKeys: SCALE_PAIR };
export const ROTATION: NumberParamDescriptor = { valueKind: "number", paramKey: "rotation_deg", labelKey: "property_panel.rotation", fallback: 0, step: 1, widgets: ["number"] };
/// The transform pivot, NORMALIZED (0.5 = centre, the fallback), not pixels:
/// that is what the wire stores, and the inspector has no natural size to
/// convert with — only the renderer's gizmo probe does. Deliberately UNBOUNDED
/// (no min/max): a pivot outside the layer's own box is a legitimate authoring
/// choice, e.g. swinging a layer about a point off-screen.
///
/// LANDMINE: writing this field moves the picture whenever the layer is rotated
/// or is a Text layer (its `x`/`y` IS the anchor point). That asymmetry is
/// intentional and matches AE — the on-canvas target compensates `x`/`y` so the
/// picture stays put, the number field does not.
export const ANCHOR_X: NumberParamDescriptor = { valueKind: "number", paramKey: "anchor_x", labelKey: "property_panel.anchor_x", fallback: 0.5, step: 0.01, widgets: ["number"] };
export const ANCHOR_Y: NumberParamDescriptor = { valueKind: "number", paramKey: "anchor_y", labelKey: "property_panel.anchor_y", fallback: 0.5, step: 0.01, widgets: ["number"] };
export const OPACITY: NumberParamDescriptor = { valueKind: "number", paramKey: "opacity", labelKey: "property_panel.opacity", fallback: 1, step: 0.01, min: 0, max: 1, widgets: ["slider", "readout"] };
export const GAIN_DB: NumberParamDescriptor = { valueKind: "number", paramKey: "gain_db", labelKey: "property_panel.gain_db", fallback: 0, step: 0.5, min: -30, max: 20, widgets: ["number"] };
export const PAN: NumberParamDescriptor = { valueKind: "number", paramKey: "pan", labelKey: "property_panel.pan", fallback: 0, step: 0.05, min: -1, max: 1, widgets: ["slider"] };
/// The two kinds that carry an animatable colour differ only in the value an
/// unkeyed track falls back to — the same value each kind's factory creates a
/// layer with, so an unset swatch shows what the layer actually looks like:
/// white for glyphs, black for a fill.
export const COLOR_TEXT: RgbaParamDescriptor = { valueKind: "rgba", paramKey: "color", labelKey: "property_panel.color", fallback: { r: 255, g: 255, b: 255, a: 255 } };
export const COLOR_FILL: RgbaParamDescriptor = { valueKind: "rgba", paramKey: "color", labelKey: "property_panel.color", fallback: { r: 0, g: 0, b: 0, a: 255 } };

/// `scaleLinked` collapses the scale pair into the composite SCALE descriptor —
/// pass the layer's `scale_linked` so every consumer (inspector rows, timeline
/// lanes, curve graph, search) shows ONE Scale for a linked layer.
export function animatableParams(kind: string, scaleLinked = false): ParamDescriptor[] {
  switch (kind) {
    case "VideoClip":
    case "Motif":
    case "ImageOverlay":
    // A Group carries the media-bearing transform set and nothing else: no
    // crop, no speed, no flip (ADR 0052 §4 leaves time-remapping out of v1), so
    // it lands on exactly the same rows as a video clip minus those.
    case "CompositionRef":
      return scaleLinked
        ? [X, Y, SCALE, ROTATION, ANCHOR_X, ANCHOR_Y, OPACITY]
        : [X, Y, SCALE_X, SCALE_Y, ROTATION, ANCHOR_X, ANCHOR_Y, OPACITY];
    // Text is the transform set plus the glyph colour, which sits after opacity
    // for the same reason opacity is last: it is the appearance of the layer,
    // not its placement. The shadow and outline colours are static fields, not
    // tracks, so they carry no descriptor.
    case "Text":
      return scaleLinked
        ? [X, Y, SCALE, ROTATION, ANCHOR_X, ANCHOR_Y, OPACITY, COLOR_TEXT]
        : [X, Y, SCALE_X, SCALE_Y, ROTATION, ANCHOR_X, ANCHOR_Y, OPACITY, COLOR_TEXT];
    case "Audio":
      return [GAIN_DB, PAN];
    // A Color layer's fill is its only animatable param: it has no transform
    // and no opacity of its own.
    case "Color":
      return [COLOR_FILL];
    default:
      return [];
  }
}

/// The layer's `scale_linked` off the flattened params view (false for kinds
/// without a transform, and for a null/missing layer) — the argument
/// `animatableParams` wants.
export function readScaleLinked(params: LayerSummary["params"] | null | undefined): boolean {
  return (params as unknown as { scale_linked?: boolean } | null | undefined)?.scale_linked === true;
}

/// The keys a write to `paramKey` on this layer must fan out to, or null for a
/// plain single-track write — the timeline sink's one question. Non-null
/// exactly when the layer is linked and the key is either scale axis.
export function scaleFanOutFor(paramKey: string, params: LayerSummary["params"] | null | undefined): string[] | null {
  return SCALE_PAIR.includes(paramKey) && readScaleLinked(params) ? SCALE_PAIR : null;
}

/// True when `paramKey` on this layer is the composite Scale's hidden twin:
/// a linked layer's scale is ONE lane (reading scale_x), so its keyed scale_y
/// must not surface diamonds or navigator stops in a neighbour's Scale Y lane.
export function isHiddenTwinAxis(paramKey: string, params: LayerSummary["params"] | null | undefined): boolean {
  return paramKey === "scale_y" && readScaleLinked(params);
}

/// Read the `AnimTrack<number>` for `paramKey` off the flattened params view.
/// `null` if the kind doesn't carry that param. Call ONLY with keys whose
/// descriptor is `valueKind: "number"`: `"color"` is an `AnimTrack<Rgba>` and
/// would come back mis-typed. Where the descriptor is in hand, prefer
/// `readNumberTrack` / `readRgbaTrack`, which make the compiler check that.
export function readParamTrack(
  params: LayerSummary["params"],
  paramKey: string,
): AnimTrack<number> | null {
  const v = (params as unknown as Record<string, unknown>)[paramKey];
  if (v && typeof v === "object" && "mode" in (v as object)) {
    return v as AnimTrack<number>;
  }
  return null;
}

/// The descriptor-typed reads. Same lookup as `readParamTrack`, with the
/// descriptor's `valueKind` standing in for the runtime check the flattened
/// params view cannot give us: the caller has to hold the matching descriptor,
/// so a colour track cannot reach a number field by naming its key.
export function readNumberTrack(
  params: LayerSummary["params"],
  desc: NumberParamDescriptor,
): AnimTrack<number> | null {
  return readParamTrack(params, desc.paramKey);
}

export function readRgbaTrack(
  params: LayerSummary["params"],
  desc: RgbaParamDescriptor,
): AnimTrack<Rgba> | null {
  return readParamTrack(params, desc.paramKey) as AnimTrack<Rgba> | null;
}

// ── Numeric precision policy ───────────────────────────────────────────────
//
// Every canvas gesture ends in a division — `dxClient / fit.scale`, the scale
// solve, the uniform-snap `t` — and the preview has a FIT scale only, no 1:1
// zoom, so that divisor is never 1. Nothing downstream absorbed the remainder,
// so an authored position was a full f64 of which only the first three digits
// were ever shown. This table is where the remainder goes.
//
// Deliberately NOT `ParamDescriptor.step`. `step` is ergonomics — how far one
// arrow key walks — and `d` is resolution — how finely a value can be recorded
// at all. Three of the seven differ, and not slightly: an arrow key that walks
// scale by 5% is good design, a scale that can only BE a multiple of 5% is a
// defect.
//
// A decimal PLACE COUNT rather than a step width, because one number has to
// serve two consumers: the mutation layer quantizes with it and the inspector
// formats with it. A width like 0.05 is expressible by neither `toFixed` nor
// `Intl.NumberFormat`, so the readout would need a second rule — and two rules
// about one value is the defect this table exists to end.

/** The authored precision of one f64 param. */
export interface ParamPrecision {
  /// Decimal places an authored value is recorded to.
  d: number;
  /// Closed range an authored value must lie in. Absent is a DECISION for most
  /// keys, not an omission: a layer parked off-screen (`x`/`y`), a pivot outside
  /// its own box (`anchor_*`, see ANCHOR_X above), a rotation past 360° and a
  /// mirrored layer (negative `scale`) are all legitimate authoring. Present
  /// only where the range is a hard property of the quantity itself.
  ///
  /// Out-of-range is REFUSED, never clamped — the no-silent-clamping red line
  /// (ADR 0048). Quantization is the opposite and is silent, because precision
  /// is a property of the FIELD while range is the user's INTENT; the time
  /// domain has silently quantized to its lattice since ADR 0037 on exactly
  /// that reasoning.
  range?: readonly [number, number];
}

/** THE precision table, keyed by the same param keys `f64Lens` resolves.
 *
 *  LANDMINE — `x`/`y` MUST keep a half-pixel expressible, so `d` here can never
 *  drop to 0. `compW / 2` is both a snap line (`previewSnap.snapTargets`) and
 *  where `centerInFrame.centerShift` lands a layer, and on an odd-width
 *  composition that is a `.5`. At integer pixels, CENTRING would miss the centre
 *  by half a pixel and the alignment guide would draw beside the layer it
 *  claims to align. `d = 1` is the only value that both expresses `.5` and
 *  survives a decimal formatter. */
export const PARAM_PRECISION: Readonly<Record<string, ParamPrecision>> = {
  x: { d: 1 },
  y: { d: 1 },
  scale_x: { d: 3 },
  scale_y: { d: 3 },
  rotation_deg: { d: 1 },
  // Normalized, so a place count buys far more here than in pixels: 1e-4 of a
  // 4K width is 0.38 px, which is the same order as `x`'s own quantum.
  anchor_x: { d: 4 },
  anchor_y: { d: 4 },
  opacity: { d: 3, range: [0, 1] },
  gain_db: { d: 1 },
  pan: { d: 3, range: [-1, 1] },
};

/** An authored pixel EXTENT — a text box axis, a Color layer's size. In pixels
 *  like `x`/`y` but INTEGER, and the difference is what the number is for: a
 *  position says where something sits, so half a pixel is a real place to sit,
 *  while an extent says how big a surface is. A text box lays glyphs out
 *  (ADR 0049) and a Color layer is rasterized; neither has any use for half of
 *  one.
 *
 *  Kept apart from `PARAM_PRECISION` because extents are plain scalars, not
 *  `Animated` tracks — they never reach a param-key resolver, so the table keyed
 *  by param keys is the wrong home and its coverage gate would reject them. */
export const PIXEL_EXTENT_PRECISION: ParamPrecision = { d: 0 };

/** Every effect param, at one precision.
 *
 *  Per-param specs exist (`render/effects/effectRegistry.ts`), but that module
 *  imports `pixi.js`, so the main process — where quantization runs — cannot
 *  read it at all. Splitting it would buy nothing: the whole catalog is `[0,1]`,
 *  `[0,10]`/`[-5,5]` and `[-100,100]` scalars, not one of which needs finer than
 *  0.001 or would visibly suffer from it. The registry already concedes the
 *  point by letting `step` default off the range width.
 *
 *  KNOWN CRACK: `viewMatte` is a boolean wearing `[0, 1]` step 1, so an agent
 *  can still write it 0.5. Its `apply` thresholds, so that is inert today — and
 *  it is the one thing that would justify splitting the registry later. */
export const EFFECT_PARAM_DECIMALS = 3;

/** `v` recorded to `d` decimal places, or `v` unchanged when it is not finite
 *  (a non-finite param is a refusal's business, not a rounding one).
 *
 *  Ties break AWAY FROM ZERO, which is why this is not a bare `Math.round(v * p)`
 *  — that breaks them toward +∞, so it would round -0.05 to -0.0 while both of
 *  the other two things that round this same quantity go to -0.1: `Intl`'s
 *  default `halfExpand` (so the readout would disagree with the stored value on
 *  exactly the values a slider lands on) and Rust's `f64::round` (so the caption
 *  twin would disagree with its TS side). One rule, three implementations.
 *
 *  `-0` is normalized to `0`. It compares equal either way, but it serializes
 *  into the project file as `-0` and reads as a defect. */
export function quantize(v: number, d: number): number {
  if (!Number.isFinite(v)) return v;
  const p = 10 ** d;
  const q = Math.round(Math.abs(v) * p) / p;
  return q === 0 ? 0 : v < 0 ? -q : q;
}

/** Decimal places for `paramKey` — table hit, else the effect-param fallback.
 *  An unknown key answers the fallback rather than throwing: only `f64Lens` can
 *  tell an effect path from a typo, and it refuses the typo itself. Call this
 *  AFTER the lens has resolved and a typo can no longer reach here. */
export function paramDecimals(paramKey: string): number {
  return PARAM_PRECISION[paramKey]?.d ?? EFFECT_PARAM_DECIMALS;
}

/** `v` at `paramKey`'s precision. */
export function quantizeParam(paramKey: string, v: number): number {
  return quantize(v, paramDecimals(paramKey));
}

/** `paramKey`'s hard range, or null when the quantity is unbounded by design. */
export function paramRange(paramKey: string): readonly [number, number] | null {
  return PARAM_PRECISION[paramKey]?.range ?? null;
}

/** `Intl.NumberFormat` options that make a readout round-trip: a formatted value
 *  parses back to exactly the quantized value it came from.
 *
 *  `useGrouping: false` is not cosmetic. Base UI's number field renders through
 *  `Intl` and commits what it parses back, so a grouped `1,920.5` is both wrong
 *  for a pixel coordinate and a parse away from `NaN`. Grouping off, the field's
 *  Enter-with-no-edit commits a value identical to the stored one, which its
 *  dedup guard then swallows — that round trip used to log a phantom undo entry.
 *
 *  `maximumFractionDigits` only (no minimum): a trailing `.0` would be noise,
 *  and `Number("993")` is still exactly `quantize(993, 1)`. */
export function paramNumberFormat(paramKey: string): Intl.NumberFormatOptions {
  return { maximumFractionDigits: paramDecimals(paramKey), useGrouping: false };
}

/** One param value as text. The read-only readout renders through this and the
 *  editable number field renders through `paramNumberFormat`, both landing on the
 *  same `Intl` options — so the same value cannot show as `0.50` in one widget
 *  and `0.5` in the other, which is what a hard-coded `toFixed` here used to do.
 *
 *  Formats what the value RECORDS as, not the value: `quantize` runs first, so a
 *  legacy f64 from before this table existed still reads as the number an edit
 *  would store, and a `-0` — which `Intl` renders with its sign — is normalized
 *  on the way through. The `Intl` place cap is then belt-and-braces; it agrees
 *  with the quantization by construction. */
export function formatParam(paramKey: string, v: number): string {
  return quantizeParam(paramKey, v).toLocaleString(undefined, paramNumberFormat(paramKey));
}
