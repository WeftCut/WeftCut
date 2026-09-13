// Full-window pick overlay + magnifier. ALL hover-rate work is imperative DOM
// through refs — pointer-move-rate React state is banned (playhead-gate
// discipline); the only React state is the store's session presence.
// Spec: docs/features.md#color-picker-eyedropper

import { useEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { sampleHex, type FrameBuffer } from "./pixel";
import { getPreviewSampler } from "./previewSamplerRegistry";
import { usePickSessionStore, startScreenPick, type PickSession } from "./pickColor";
import { screenPickAvailable } from "./screenPick";
import { createMagnifier, magnifierPosition } from './magnifier';

const MAG_RADIUS = 5; // 11×11 source patch
const MAG_SCALE = 10; // → 110×110 magnifier canvas

const MAGNIFIER_STYLE: CSSProperties = {
  position: "fixed",
  left: 0,
  top: 0,
  visibility: "hidden",
  pointerEvents: "none",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
};

const HINT_STYLE: CSSProperties = {
  position: "fixed",
  bottom: 24,
  left: "50%",
  transform: "translateX(-50%)",
  font: "12px system-ui",
  color: "#e5e7eb",
  background: "rgba(0,0,0,0.7)",
  padding: "4px 10px",
  borderRadius: 4,
  pointerEvents: "none",
};

export function PickOverlayHost() {
  const session = usePickSessionStore((s) => s.session);
  if (!session) return null;
  return <PickOverlay session={session} />;
}

interface Hit {
  hex: string;
  source: "composition" | "ui";
  patchBuf: FrameBuffer;
  px: number;
  py: number;
}

function PickOverlay({ session }: { session: PickSession }) {
  const { t } = useTranslation();
  const screenPicking = usePickSessionStore(s => s.screenPicking);
  const screenError = usePickSessionStore(s => s.screenError);
  const magRef = useRef<HTMLDivElement | null>(null);
  const magCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hexRef = useRef<HTMLSpanElement | null>(null);
  const raf = useRef<number | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const painter = useRef<{ canvas: HTMLCanvasElement; draw: ReturnType<typeof createMagnifier> } | null>(null);

  const sampleAt = (x: number, y: number): Hit | null => {
    const sampler = getPreviewSampler();
    if (session.comp && sampler) {
      const rect = sampler.canvasRect();
      if (rect && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
        const m = sampler.mapClientToComposition(x, y);
        if (m) {
          return {
            hex: sampleHex(session.comp, m.x, m.y),
            source: "composition",
            patchBuf: session.comp,
            px: m.x,
            py: m.y,
          };
        }
        // Letterbox bars inside the canvas element are painted chrome, not
        // composition content — fall through to the window snapshot.
      }
    }
    if (session.snap) {
      const buf: FrameBuffer = {
        pixels: session.snap.data.data,
        width: session.snap.data.width,
        height: session.snap.data.height,
      };
      const sx = Math.floor(x * session.snap.scaleX);
      const sy = Math.floor(y * session.snap.scaleY);
      return { hex: sampleHex(buf, sx, sy), source: "ui", patchBuf: buf, px: sx, py: sy };
    }
    return null;
  };

  const update = () => {
    raf.current = null;
    if (usePickSessionStore.getState().screenPicking) return;
    const p = last.current;
    if (!p) return;
    const hit = sampleAt(p.x, p.y);
    const mag = magRef.current;
    if (mag) {
      const position = magnifierPosition(p.x, p.y, mag.offsetWidth, mag.offsetHeight, window.innerWidth, window.innerHeight);
      mag.style.transform = `translate(${position.x}px, ${position.y}px)`;
      mag.style.visibility = hit ? "visible" : "hidden";
    }
    if (!hit) return;
    if (hexRef.current) hexRef.current.textContent = hit.hex;
    const canvas = magCanvasRef.current;
    if (canvas) {
      if (painter.current?.canvas !== canvas) painter.current = { canvas, draw: createMagnifier(canvas) };
      painter.current.draw(hit.patchBuf, hit.px, hit.py);
    }
    session.opts.onHover?.(hit.hex);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    last.current = { x: e.clientX, y: e.clientY };
    if (raf.current === null) raf.current = requestAnimationFrame(update);
  };

  const onClick = (e: React.MouseEvent) => {
    const p = down.current ?? { x: e.clientX, y: e.clientY };
    down.current = null;
    const hit = sampleAt(p.x, p.y);
    if (hit) session.settle({ hex: hit.hex, source: hit.source });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        session.settle(null);
      } else if (
        (e.key === "s" || e.key === "S") &&
        !e.ctrlKey && !e.metaKey && !e.altKey &&
        screenPickAvailable()
      ) {
        e.preventDefault();
        e.stopPropagation();
        void startScreenPick(session, t('colorpick.screen_hint'));
      }
    };
    const onBlur = () => {
      if (!usePickSessionStore.getState().screenPicking) session.settle(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [session, t]);

  // Block editor gestures during capture without painting UI into the desktop
  // snapshot. Keyboard cancellation remains owned by this mounted session.
  if (screenPicking) return <div aria-busy="true" style={{ position: 'fixed', inset: 0, zIndex: 1000, cursor: 'progress' }} />;

  return (
    <div
      data-testid="colorpick-overlay"
      onPointerMove={onPointerMove}
      onPointerDown={e => { if (e.button === 0) down.current = { x: e.clientX, y: e.clientY }; }}
      onClick={onClick}
      style={{ position: "fixed", inset: 0, zIndex: 1000, cursor: "crosshair" }}
    >
      <div
        ref={magRef}
        style={MAGNIFIER_STYLE}
      >
        <canvas
          ref={magCanvasRef}
          width={(MAG_RADIUS * 2 + 1) * MAG_SCALE}
          height={(MAG_RADIUS * 2 + 1) * MAG_SCALE}
          style={{ border: "2px solid var(--border)", borderRadius: 6, background: "#000" }}
        />
        <span
          ref={hexRef}
          // Written in the same rAF pass that fires `onHover` (the live-apply),
          // which makes it the one observable proof from outside that a hover
          // was sampled — colorpick.spec.ts waits on it before asserting that
          // the hover recorded NOTHING in the project.
          data-testid="colorpick-hex"
          style={{
            font: "12px ui-monospace, monospace",
            color: "#e5e7eb",
            background: "rgba(0,0,0,0.7)",
            padding: "1px 6px",
            borderRadius: 3,
          }}
        />
      </div>
      <div
        style={HINT_STYLE}
      >
        {t("colorpick.hint_cancel")}
        {screenPickAvailable() ? ` · ${t("colorpick.hint_screen")}` : ""}
        {screenError && <div role="alert">{t(`colorpick.error_${screenError}`)}</div>}
      </div>
    </div>
  );
}
