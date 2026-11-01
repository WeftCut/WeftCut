// What this host's renderer can draw, asked once and shared by the preview,
// `render_frames` stills and export (spec D1).
//
// Pixi picks a backend in order — WebGPU, then WebGL, then the 2D-canvas
// `CanvasRenderer` — and the canvas renderer is not a lesser GPU: its filter
// system skips every filter that has no CSS equivalent (none of ours has one,
// it only warns), and it has no mesh pipe, so a shader quad is not collected
// at all. On a VM without GPU passthrough, a blocklisted driver or software GL
// that is every clip effect, every crop and every transition, gone without an
// error. Text, sprites, video frames, Motif frames and Groups draw.
//
// So the question is asked of the content, not the host: a frame that holds
// none of those features renders anywhere, and one that holds them is refused
// on a renderer that cannot draw them. The worker re-asks with the renderer it
// actually got (`capabilityOf`), so a context lost between the probe and the
// run refuses too instead of drawing the frame wrong.
import { isWebGLSupported, isWebGPUSupported } from "pixi.js";

import { VISUAL_EFFECT_PARAMS } from "../../shared/effects/params";
import type { CompositionSummary, LayerSummary, ProjectSummary } from "../ipc";
import { forEachLayerInTime, type PlacedLayer } from "./compositionWalk";
import { rootAt } from "./compositionClock";

export type RendererName = "webgpu" | "webgl" | "canvas";

/// Content a frame can hold that not every renderer draws.
export type DrawFeature = "effects" | "crop" | "transitions";
export const DRAW_FEATURES: readonly DrawFeature[] = ["effects", "crop", "transitions"];

/// What a refused frame needs from the host.
export const RENDERER_NEEDS = "WebGPU or WebGL2";

export interface RendererCapability {
  /// What the preview, stills and the WebCodecs export composite with — Pixi
  /// preferring WebGPU, as all three do.
  renderer: RendererName;
  /// A WebGL context exists. The native encoder's pack pass, native decode's
  /// ingest and the 10-bit composite are GL shaders and need it.
  webgl: boolean;
  /// Per feature: does `renderer` draw it.
  draws: Readonly<Record<DrawFeature, boolean>>;
}

/// The table for a renderer the caller already holds (the export worker's own).
export function capabilityOf(renderer: RendererName, webgl: boolean): RendererCapability {
  const gpu = renderer !== "canvas";
  return { renderer, webgl, draws: { effects: gpu, crop: gpu, transitions: gpu } };
}

/// Pixi's `renderer.name` as a `RendererName` (anything unknown is treated as
/// the weakest).
export function rendererNameOf(name: string): RendererName {
  return name === "webgpu" || name === "webgl" ? name : "canvas";
}

let probe: Promise<RendererCapability> | undefined;
let settled: RendererCapability | null = null;
const listeners = new Set<() => void>();

/// THE capability query: the same detectors `autoDetectRenderer` consults
/// (Pixi caches their answers per realm, so this is the decision the preview's
/// own init made), asked once.
export function rendererCapability(): Promise<RendererCapability> {
  probe ??= (async () => {
    const webgpu = await isWebGPUSupported();
    const webgl = isWebGLSupported();
    const cap = capabilityOf(webgpu ? "webgpu" : webgl ? "webgl" : "canvas", webgl);
    settled = cap;
    for (const listener of listeners) listener();
    return cap;
  })();
  return probe;
}

/// The answer for a React reader: null until the query has settled.
export function settledRendererCapability(): RendererCapability | null {
  return settled;
}
export function subscribeRendererCapability(listener: () => void): () => void {
  listeners.add(listener);
  void rendererCapability();
  return () => { listeners.delete(listener); };
}

/// Feature → the layers that carry it.
export type DrawNeeds = Map<DrawFeature, Set<string>>;

/// Which features `[t0Us, t1Us)` of `compId` (its own clock) holds, and on
/// which layers: enabled visual effects (`effects: false` skips them — the
/// preview with effects switched off), a crop, a transition window. Group
/// layers count for their own effects and transitions. Accumulates into `into`.
export function drawNeeds(
  summary: ProjectSummary,
  compId: string,
  t0Us: number,
  t1Us: number,
  into: DrawNeeds = new Map(),
  effects = true,
): DrawNeeds {
  const note = (feature: DrawFeature, id: string) => {
    let ids = into.get(feature);
    if (!ids) into.set(feature, (ids = new Set()));
    ids.add(id);
  };
  const visit = (p: PlacedLayer) => {
    const { layer } = p;
    if (effects && layer.effects.some((e) => e.enabled && Object.hasOwn(VISUAL_EFFECT_PARAMS, e.kind))) note("effects", layer.id);
    if (layer.params.kind === "VideoClip" && layer.params.crop) note("crop", layer.id);
    const comp = summary.compositions[p.compositionId];
    for (const tr of comp?.transitions ?? []) {
      if (tr.to_layer !== layer.id || tr.duration_us <= 0) continue;
      const from = enabledLayer(comp!, tr.from_layer);
      if (!from) continue;
      // The window the node composites, on this composition's clock, then
      // placed on the walk's clock and clipped to the placement and the query.
      const s = Math.max(layer.t_start_us, from.t_start_us);
      const e = Math.min(layer.t_start_us + tr.duration_us, from.t_end_us, layer.t_end_us);
      if (s >= e) continue;
      const rs = Math.max(p.clock ? rootAt(p.clock, s) : p.offsetUs + s, p.tStartUs, t0Us);
      const re = Math.min(p.clock ? rootAt(p.clock, e) : p.offsetUs + e, p.tEndUs, t1Us);
      if (rs < re) { note("transitions", from.id); note("transitions", layer.id); }
    }
  };
  forEachLayerInTime(summary, compId, t0Us, t1Us, 0, { leaf: visit, group: visit });
  return into;
}

function enabledLayer(comp: CompositionSummary, id: string): LayerSummary | null {
  for (const track of comp.tracks) {
    if (!track.enabled) continue;
    const layer = track.layers.find((l) => l.id === id);
    if (layer) return layer.enabled ? layer : null;
  }
  return null;
}

/// The typed refusal (`RendererCannotDraw`) a render or an export answers with.
export interface RendererCannotDraw {
  [key: string]: unknown;
  error: "RendererCannotDraw";
  renderer: RendererName;
  missing: DrawFeature[];
  layer_ids: string[];
  needs: string;
}

/// The refusal for `needs` on `cap`, or null when every feature is drawn.
export function cannotDraw(cap: RendererCapability, needs: DrawNeeds): RendererCannotDraw | null {
  const missing = DRAW_FEATURES.filter((f) => (needs.get(f)?.size ?? 0) > 0 && !cap.draws[f]);
  if (missing.length === 0) return null;
  const layerIds = [...new Set(missing.flatMap((f) => [...needs.get(f)!]))];
  return { error: "RendererCannotDraw", renderer: cap.renderer, missing, layer_ids: layerIds, needs: RENDERER_NEEDS };
}

/// The agent-facing sentence for a refusal (`render_frames`, and the worker's
/// backstop). The UI words its own through i18n.
export function cannotDrawMessage(r: RendererCannotDraw & { t_us?: number[] }, what: string): string {
  const list = (xs: readonly (string | number)[]) => xs.length > 6 ? `${xs.slice(0, 6).join(", ")} and ${xs.length - 6} more` : xs.join(", ");
  const at = r.t_us?.length ? ` at t_us ${list(r.t_us)}` : " in the requested span";
  return `${what} refused: this host renders with the ${r.renderer} fallback (no ${r.needs}), which cannot draw ${r.missing.join(" or ")}, and layer(s) ${list(r.layer_ids)} carry them${at}. Nothing was drawn without them. Frames without these features render; drawing them needs ${r.needs} (a GPU with hardware acceleration on).`;
}

/// `render_frames` refused because the host's renderer cannot draw what the
/// requested frames hold; `fault` is the typed refusal the MCP mapper passes on.
export class RendererCannotDrawError extends Error {
  constructor(readonly fault: RendererCannotDraw & { t_us?: number[] }) {
    super(cannotDrawMessage(fault, "render_frames"));
    this.name = "RendererCannotDrawError";
  }
}
