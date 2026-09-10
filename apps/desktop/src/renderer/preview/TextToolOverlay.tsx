// The Text tool's click surface over the preview canvas (ADR 0067): while the
// tool is armed, a click on a Text layer opens the inline editor on it, and a
// click on empty frame creates a Text layer centred on the click point and
// opens the editor on that. Nothing else changes — the timeline behaves as
// under the Selection tool, and the transform gizmo goes display-only
// (`TransformGizmo.tsx` sets `data-inert`) so every press on the frame reaches
// the one hit test in `textHitTest.ts`.
//
// A DOM element sized to the CANVAS box, not the panel's: the I-beam and the
// surface stop at the letterbox, and a click there means nothing. It sits
// BELOW the gizmo host in DOM order so an open editor's textarea and its
// buttons stay clickable above it; the gizmo's own targets are the ones made
// inert, not the editor's.
//
// Creation reuses the Insert menu's path end to end — `add_text_layer` with
// the factory defaults, then the same select + reveal — and differs from it in
// the position alone. The layer exists before the editor opens; a phantom
// editor would need a second copy of the text defaults in the renderer, which
// is the drift ADR 0049 removed.

import { useEffect, useRef } from "react";

import { logMutationFailure } from "../errors/tryMutate";
import type { CompositionSummary } from "../ipc";
import { addTextLayerIn } from "../ipc/compositionScoped";
import { usePreviewRenderTargetId } from "../state/compositionAnchorStore";
import { revealLayerWithoutSeek } from "../state/navigation";
import { transportPause } from "../state/playbackStore";
import { focusedPlayheadUs } from "../state/playheadProjection";
import { useOpenComposition, useProjectStore } from "../state/projectStore";
import {
  beginTextEdit,
  consumesPointerDown,
  textEditingLayerId,
} from "../state/textEditingStore";
import { activeTool, setTool, useActiveTool } from "../state/toolStore";
import { containFit, type Pt } from "./gizmoGeometry";
import { getGizmoProbe } from "./gizmoProbeRegistry";
import { observeClientRect } from "./layoutRectCache";
import { hitTestTextLayer } from "./textHitTest";

/// Pointer travel between press and release beyond which the gesture is not a
/// click. Nothing happens past it in this version — that branch is where a
/// drag-to-box lands later, which is why creation waits for the RELEASE rather
/// than firing on the press.
export const CLICK_SLOP_PX = 4;

/// How long to wait for the created layer to reach the project mirror before
/// giving up on opening its editor. The layer itself is committed either way.
const LAYER_ARRIVAL_TIMEOUT_MS = 5_000;

/// Mounts the surface while the Text tool is armed AND the preview is drawing
/// the focused composition — the gizmo host's own guard, for its reason: the
/// click's frame coordinate only means something when the canvas IS this
/// composition's frame. The Escape binding is mounted on the tool alone, so a
/// user can always leave the tool from wherever the preview is pointed.
export function TextToolOverlayHost() {
  const tool = useActiveTool();
  const composition = useOpenComposition();
  const renderTargetId = usePreviewRenderTargetId();

  // Escape returns to Selection, as it does for the Blade in Timeline. An open
  // editor owns its own Escape (finish the edit) and stops the key before it
  // reaches the window; this is the Escape AFTER that one.
  useEffect(() => {
    if (tool !== "text") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (textEditingLayerId() !== null) return;
      e.preventDefault();
      setTool("select");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  if (tool !== "text" || !composition) return null;
  if (renderTargetId !== composition.id) return null;
  return <TextToolOverlay composition={composition} />;
}

/// Resolves once the project mirror holds `layerId` — the point at which it can
/// be selected (`selectLayers` validates against the live index) and its gizmo
/// can mount. `add_text_layer` resolves with the id before `project:changed`
/// has delivered the summary that carries the layer, so the two are decoupled.
function layerInStore(layerId: string): Promise<boolean> {
  if (useProjectStore.getState().layerById.has(layerId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, LAYER_ARRIVAL_TIMEOUT_MS);
    const unsubscribe = useProjectStore.subscribe((s) => {
      if (!s.layerById.has(layerId)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

/// The click, resolved: edit the Text layer under `point`, or create one there.
async function actAt(composition: CompositionSummary, point: Pt): Promise<void> {
  // Pause first, then read the moment: both branches want the layer's span
  // judged, and the new layer placed, at the frame the user is looking at.
  transportPause();
  const tUs = focusedPlayheadUs();
  const probe = getGizmoProbe();
  const hit = probe
    ? hitTestTextLayer({
        composition,
        tUs,
        point,
        naturalSizeOf: (id) => probe.naturalSizeOf(id),
      })
    : null;
  if (hit) {
    // Select + reveal, so the inspector and timeline follow, then open. The
    // gizmo for the layer reads the store on mount and opens the editor.
    if (!revealLayerWithoutSeek(hit.id)) return;
    beginTextEdit(hit.id);
    return;
  }

  let layerId: string;
  try {
    layerId = await addTextLayerIn({
      compositionId: composition.id,
      tStartUs: tUs,
      x: point.x,
      y: point.y,
    });
  } catch (err) {
    logMutationFailure(err, "Add text at click");
    return;
  }
  if (!(await layerInStore(layerId))) return;
  // The Insert menu's own select + reveal (the new lane is role-less, so the
  // A/B Roll filter would otherwise hide the clip just made).
  if (!revealLayerWithoutSeek(layerId)) return;
  // The tool may have been dropped while the layer was in flight; the layer
  // stands either way, as it would from the menu, but no editor opens for a
  // tool nobody is holding.
  if (activeTool() === "text") beginTextEdit(layerId);
}

function TextToolOverlay({ composition }: { composition: CompositionSummary }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Latest composition for the event handlers and the rAF loop, so neither has
  // to be re-bound on every summary tick.
  const compRef = useRef(composition);
  compRef.current = composition;
  /// The press being judged, or null. Cleared on release and on cancel.
  const press = useRef<{ x: number; y: number; pointerId: number } | null>(null);

  // Follow the canvas box. Cached layout reads, per `layoutRectCache.ts`: a
  // per-frame `getBoundingClientRect` would land in the same frame as the
  // timeline playhead's `style.left` write and reflow the document.
  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const parentRect = observeClientRect(parent);
    let drawn: string | null = null;
    let frame = 0;
    const draw = (): void => {
      frame = requestAnimationFrame(draw);
      const rect = getGizmoProbe()?.canvasRect();
      if (!rect) {
        if (drawn !== "hidden") {
          drawn = "hidden";
          el.style.display = "none";
        }
        return;
      }
      const own = parentRect.rect();
      const signature = `${rect.left},${rect.top},${rect.width},${rect.height};${own.left},${own.top}`;
      if (signature === drawn) return;
      drawn = signature;
      el.style.display = "";
      el.style.left = `${rect.left - own.left}px`;
      el.style.top = `${rect.top - own.top}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      parentRect.dispose();
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    // The press that closed an open editor is spent on closing it — the editor
    // saw this same event first (`InlineTextEditor.tsx`) and said so.
    if (consumesPointerDown(e.nativeEvent)) {
      press.current = null;
      return;
    }
    press.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    // Capture, so the release reaches this element even if the pointer has
    // wandered off it — the slop test below needs to see every release.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = press.current;
    press.current = null;
    if (!p || p.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP_PX) return;
    const rect = getGizmoProbe()?.canvasRect();
    if (!rect) return;
    const comp = compRef.current;
    const fit = containFit(rect, comp.width, comp.height);
    if (!fit) return;
    const point: Pt = {
      x: (e.clientX - fit.offX) / fit.scale,
      y: (e.clientY - fit.offY) / fit.scale,
    };
    // The element is the canvas box, so this only fails on a rounding edge —
    // but a point outside the frame has no layer under it and is no place to
    // put one, so it is dropped rather than clamped.
    if (!(point.x >= 0 && point.x <= comp.width && point.y >= 0 && point.y <= comp.height)) return;
    void actAt(comp, point);
  };

  return (
    <div
      ref={ref}
      className="preview-text-tool"
      data-testid="preview-text-tool"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        press.current = null;
      }}
    />
  );
}
