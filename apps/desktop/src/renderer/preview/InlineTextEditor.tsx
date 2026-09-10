import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { updateLayerParams, type CompositionSummary, type LayerSummary } from "../ipc";
import { tryMutate } from "../errors/tryMutate";
import { transportPause } from "../state/playbackStore";
import { focusedPlayheadUs, useFocusedPlayheadUsThrottled } from "../state/playheadProjection";
import { layerFrameAt } from "./centerInFrame";
import { containFit, compToClient, layerQuad } from "./gizmoGeometry";
import { getGizmoProbe } from "./gizmoProbeRegistry";

type TextLayer = LayerSummary & { params: Extract<LayerSummary["params"], { kind: "Text" }> };

export function EditableTextGizmo({ layer, composition, locked, children }: {
  layer: LayerSummary;
  composition: CompositionSummary;
  locked: boolean;
  children: (onEdit: () => void) => ReactNode;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const timeUs = useFocusedPlayheadUsThrottled();
  const inSpan = timeUs >= layer.t_start_us && timeUs < layer.t_end_us;
  useEffect(() => {
    if (!inSpan || locked) setEditing(false);
  }, [inSpan, locked]);
  if (layer.params.kind !== "Text") return null;
  const start = () => {
    const now = focusedPlayheadUs();
    if (locked || now < layer.t_start_us || now >= layer.t_end_us) return;
    transportPause();
    setEditing(true);
  };
  return <>
    {editing && !locked && inSpan
      ? <InlineTextEditor layer={layer as TextLayer} composition={composition} onDone={() => setEditing(false)} />
      : children(start)}
    {!editing && !locked && inSpan && <button
      type="button"
      className="preview-edit-text"
      onClick={start}
      title={t("preview.edit_text_hint")}
    >{t("preview.edit_text")}</button>}
  </>;
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
      if (!wrapper.current?.contains(event.target as Node)) finishRef.current(true);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);

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
      aria-describedby="preview-text-edit-hint"
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
      onBlur={() => finishRef.current(true)}
      onKeyDown={event => {
        event.stopPropagation();
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          finishRef.current(false);
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          finishRef.current(true);
        }
      }}
    />
    <div className="preview-text-edit-hint" id="preview-text-edit-hint">
      {failed ? <span role="alert">{t("preview.edit_text_failed")}</span> : t("preview.edit_text_keys")}
    </div>
  </div>;
}
