import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { updateLayerParams, type CompositionSummary, type LayerSummary } from "../ipc";
import { tryMutate } from "../errors/tryMutate";
import { transportPause } from "../state/playbackStore";
import { focusedPlayheadUs, useFocusedPlayheadUsThrottled } from "../state/playheadProjection";
import {
  beginTextEdit,
  endTextEdit,
  markEditorClosedByPointer,
  useTextEditingLayerId,
} from "../state/textEditingStore";
import { layerFrameAt } from "./centerInFrame";
import { containFit, compToClient, layerQuad } from "./gizmoGeometry";
import { getGizmoProbe } from "./gizmoProbeRegistry";

type TextLayer = LayerSummary & { params: Extract<LayerSummary["params"], { kind: "Text" }> };

// Whether this layer's editor is open is read off `textEditingStore`, not held
// here: the Text tool opens an editor from outside this component, and may do
// so for a layer whose gizmo is still mounting (`TextToolOverlay.tsx`). The
// gizmo's double-click writes the same store, so every entry path is one path.
export function EditableTextGizmo({ layer, composition, locked, children }: {
  layer: LayerSummary;
  composition: CompositionSummary;
  locked: boolean;
  children: (onEdit: () => void) => ReactNode;
}) {
  const editing = useTextEditingLayerId() === layer.id;
  const timeUs = useFocusedPlayheadUsThrottled();
  const inSpan = timeUs >= layer.t_start_us && timeUs < layer.t_end_us;
  useEffect(() => {
    if (editing && (!inSpan || locked)) endTextEdit(layer.id);
  }, [editing, inSpan, locked, layer.id]);
  if (layer.params.kind !== "Text") return null;
  const start = () => {
    const now = focusedPlayheadUs();
    if (locked || now < layer.t_start_us || now >= layer.t_end_us) return;
    transportPause();
    beginTextEdit(layer.id);
  };
  return editing && !locked && inSpan
    ? <InlineTextEditor layer={layer as TextLayer} composition={composition} onDone={() => endTextEdit(layer.id)} />
    : children(start);
}

// A DOM textarea gives the OS a real caret for IME candidates and preserves
// native selection, paste and text undo. Drafts stay local; only finishing the
// session writes project history. Unmounting after a project/selection change
// never writes to a potentially different project.
export function InlineTextEditor({ layer, composition, onDone }: {
  layer: TextLayer;
  composition: CompositionSummary;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [initial] = useState(() => ({ layer, timeUs: focusedPlayheadUs() }));
  const params = initial.layer.params;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const saveAfterComposition = useRef(false);
  const finished = useRef(false);
  const saving = useRef(false);
  const [pending, setPending] = useState(false);
  // A refused save leaves no mark in the editor itself: the status-bar line
  // `tryMutate` logs is the one surface, as for every other direct commit.
  // This flag only changes what Escape does next.
  const [failed, setFailed] = useState(false);
  const finishRef = useRef<(save: boolean) => void>(() => {});
  const finish = async (save: boolean) => {
    if (finished.current || saving.current) return;
    if (save && composing.current) {
      saveAfterComposition.current = true;
      return;
    }
    const content = textarea.current?.value ?? params.content;
    if (save && content !== params.content) {
      saving.current = true;
      setPending(true);
      const ok = await tryMutate(
        () => updateLayerParams(initial.layer.id, { kind: "Text", content }),
        "Edit text in preview",
      );
      saving.current = false;
      setPending(false);
      if (!ok) {
        setFailed(true);
        textarea.current?.focus();
        return;
      }
    }
    finished.current = true;
    onDone();
  };
  finishRef.current = (save) => { void finish(save); };

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (wrapper.current?.contains(event.target as Node)) return;
      // Stamped BEFORE the save, so the Text tool — whose own handler for this
      // same event runs after this capture listener — can tell a closing click
      // from a click on empty frame and not create a layer under it.
      markEditorClosedByPointer(event);
      finishRef.current(true);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);

  // A blur closes the editor one task LATER, not inside the blur event. The
  // focus-region listener (`focus/useFocusRegions.ts`) runs at window capture
  // on every pointerdown and focuses the panel, which blurs this field before
  // the same pointerdown reaches `outside` above. Closing synchronously there
  // would unmount this component — and its listener — in the microtask
  // checkpoint between the two, so the closing press would never be stamped
  // and the Text tool would create a layer under it. Deferred, the press
  // still finds the listener, stamps itself and finishes the session; the
  // timer then finds it finished and does nothing. A blur with no press
  // behind it (Tab away, focus taken by code) saves on the next task instead.
  const blurClose = useRef<number | null>(null);
  useEffect(() => () => {
    if (blurClose.current !== null) window.clearTimeout(blurClose.current);
  }, []);
  const onBlur = () => {
    if (blurClose.current !== null) return;
    blurClose.current = window.setTimeout(() => {
      blurClose.current = null;
      finishRef.current(true);
    }, 0);
  };

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const probe = getGizmoProbe();
    const size = probe?.naturalSizeOf(initial.layer.id) ?? {
      w: params.box_w ?? Math.max(params.font_size_px, 80),
      h: params.box_h ?? params.font_size_px * 1.4,
    };
    const fontSize = probe?.textFitOf(initial.layer.id)?.effectivePx ?? params.font_size_px;
    const factor = fontSize / params.font_size_px;
    el.style.fontSize = `${fontSize}px`;
    el.style.lineHeight = params.line_height ? `${params.line_height * factor}px` : "normal";
    el.style.letterSpacing = `${(params.letter_spacing ?? 0) * factor}px`;
    // Chromium sizes auto axes from the draft, including the final empty line.
    // Keep the starting footprint covered so the unchanged compositor text
    // cannot peek out beneath a shorter draft. Fixed boxes retain scrolling.
    el.style.setProperty("field-sizing", "content");
    el.style.width = params.box_w == null ? "auto" : `${size.w}px`;
    el.style.minWidth = params.box_w == null ? `${Math.max(size.w, fontSize)}px` : "0";
    el.style.height = params.box_h == null ? "auto" : `${size.h}px`;
    el.style.minHeight = params.box_h == null ? `${Math.max(size.h, fontSize * 1.4)}px` : "0";
    let raf = 0;
    const draw = () => {
      const rect = getGizmoProbe()?.canvasRect();
      const parent = wrapper.current?.getBoundingClientRect();
      const fit = rect && containFit(rect, composition.width, composition.height);
      if (fit && parent) {
        const frame = layerFrameAt(initial.layer, initial.timeUs, {
          w: el.offsetWidth || size.w,
          h: el.offsetHeight || size.h,
        });
        const topLeft = layerQuad(frame)[0];
        const origin = compToClient(topLeft, fit);
        el.style.left = `${origin.x - parent.left}px`;
        el.style.top = `${origin.y - parent.top}px`;
        el.style.transform = `rotate(${frame.rotationDeg}deg) scale(${frame.scaleX * fit.scale}, ${frame.scaleY * fit.scale})`;
        el.style.visibility = "visible";
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    el.focus();
    el.select();
    return () => cancelAnimationFrame(raf);
  }, [initial, composition.width, composition.height, params]);

  // This nonmodal dialog owns Escape and restores its own editing state. The
  // generic focus-region release must not blur it before cancellation runs.
  return <div ref={wrapper} role="dialog" aria-label={t("preview.edit_text")}
    className="preview-inline-text-editor" data-inline-text-editor data-testid="preview-inline-text-editor">
    <textarea
      ref={textarea}
      aria-label={t("preview.edit_text")}
      defaultValue={params.content}
      readOnly={pending}
      spellCheck={false}
      wrap={params.box_w == null ? "off" : "soft"}
      style={{ fontFamily: params.font_family, fontWeight: params.weight,
        fontStyle: params.italic ? "italic" : "normal",
        textAlign: params.align === "Left" ? "left" : params.align === "Right" ? "right" : "center" }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => {
        composing.current = false;
        if (saveAfterComposition.current) {
          saveAfterComposition.current = false;
          queueMicrotask(() => finishRef.current(true));
        }
      }}
      onBlur={onBlur}
      onKeyDown={event => {
        event.stopPropagation();
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        // Escape FINISHES the edit, it does not cancel it: what is in the field
        // is the user's text, and a key that threw it away would sit one keycap
        // from the ones that keep it. Reverting a finished edit is undo's job —
        // the save is one history entry. The exception is a save the project
        // refused: the status bar has said so, and Escape is then the way out
        // that writes nothing.
        if (event.key === "Escape") {
          event.preventDefault();
          finishRef.current(!failed);
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          finishRef.current(true);
        }
      }}
    />
  </div>;
}
