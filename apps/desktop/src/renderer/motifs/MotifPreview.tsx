// apps/desktop/src/renderer/motifs/MotifPreview.tsx
//
// The Motif preview player: one still of a Motif's poster frame with the
// given props, re-captured as the props settle. Shared by the picker's form
// and the publication approval card (MotifProposalCard).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motifPosterTime } from '../../shared/motifs/poster';
import type { MotifSummary, PropSpec } from "../ipc";
import { captureMotifFramePngBlob } from "../render/motifs/host";

function defaultPropValue(spec: PropSpec): unknown {
  switch (spec.type) {
    case "string":
    case "color":
    case "enum":
    case "media":
      return spec.default;
    case "number":
      return spec.default;
  }
}

export function defaultPropsFor(motif: MotifSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(motif.props_schema)) {
    out[key] = defaultPropValue(spec);
  }
  return out;
}

export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/// Static still of a Motif's poster frame (see `motifPosterTime`), captured via a
/// single CDP screenshot (`captureMotifFramePngBlob`).
/// CDP cost (~80ms) makes continuous animation impractical here, and the
/// picker's job is "show what this Motif looks like", not animate it.
export function MotifPreview({
  motif,
  props,
  maxWidth,
  large,
  canvas,
  fpsNum,
  fpsDen,
}: {
  motif: MotifSummary;
  props: Record<string, unknown>;
  maxWidth: number;
  large?: boolean;
  /// Composition `[width, height]`. When set, the box becomes the canvas
  /// (comp aspect-ratio) and the motif renders at the compositor's default
  /// placement — top-left at (0,0), natural pixels relative to the canvas —
  /// instead of being contain-zoomed to fill the box.
  canvas?: [number, number];
  /// Composition fps — the capture's meta.fps must name the rate the still's
  /// tSec is authored against (a Motif reading it renders wrong at non-30 fps).
  /// Explicit `| undefined`: callers thread an optional pair through
  /// (`exactOptionalPropertyTypes`).
  fpsNum?: number | undefined;
  fpsDen?: number | undefined;
}) {
  const [w, h] = motif.size;
  const tSec = motifPosterTime(motif);
  const [compW, compH] = canvas ?? [0, 0];
  const canvasMode = compW > 0 && compH > 0;
  const { t } = useTranslation();

  const urlRef = useRef<string | null>(null);
  const [pngUrl, setPngUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Capture a single still frame via CDP whenever the Motif identity, props,
  // or dimensions change. Cancellable to handle rapid prop edits.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    captureMotifFramePngBlob(motif.id, tSec, props, w, h, motif.content_hash, undefined, fpsNum, fpsDen)
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setPngUrl(url);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
    // MotifForm debounces props, so capture fires per settled edit.
    // `content_hash` is in the deps so a same-id draft edit (new content, same id)
    // re-captures — the host reloads off the `?v=` cache-buster threaded above.
  }, [motif.id, motif.content_hash, tSec, props, w, h, fpsNum, fpsDen]);

  // Revoke the last blob URL on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  return (
    <div
      className={
        large
          ? "motif-preview-host motif-preview-large"
          : "motif-preview-host"
      }
      // The host is a 16:9 box (CSS aspect-ratio) filling the parent's width,
      // capped here — so a large or oddly-shaped motif can't blow up the
      // display area, and the box can never overflow a narrower parent (the
      // card column, or the form pane in a narrow window). Canvas mode swaps
      // the aspect for the composition's, making the box the canvas itself.
      style={
        canvasMode
          ? { maxWidth: `calc(${maxWidth} * var(--ui-px))`, aspectRatio: `${compW} / ${compH}` }
          : { maxWidth: `calc(${maxWidth} * var(--ui-px))` }
      }
    >
      {pngUrl && (
        // Default: contain-scaled + centered by `.motif-preview-host img`
        // (object-fit); the checkerboard shows through the letterbox margins.
        // Canvas mode: inline percentages override that to the motif's true
        // size relative to the canvas, anchored top-left — mirroring the
        // compositor's default placement (Transform::default → x:0, y:0,
        // scale:1, Pixi top-left anchor). Oversized motifs clip at the box
        // edge exactly as the real canvas would.
        <img
          src={pngUrl}
          alt={`preview-${motif.id}`}
          width={w}
          height={h}
          style={
            canvasMode
              ? {
                  width: `${(w / compW) * 100}%`,
                  height: `${(h / compH) * 100}%`,
                }
              : undefined
          }
        />
      )}
      {!pngUrl && !error && (
        <span
          className="motif-preview-loading"
          role="status"
          aria-label={t("motif_picker.preview_loading")}
        />
      )}
      {error && <span className="settings-error">{error}</span>}
    </div>
  );
}
