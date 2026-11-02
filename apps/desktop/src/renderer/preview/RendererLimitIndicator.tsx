// Status-area note while the preview's renderer cannot draw something on
// screen: the canvas fallback (no WebGPU or WebGL2) skips effects, crops and
// transitions (render/rendererCapability.ts). Low-key on purpose — a label and
// a tooltip with the reason and the fix, nothing over the canvas, and nothing
// at all while every frame in view is drawn as authored.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { cannotDraw, DRAW_FEATURES, drawNeeds, type RendererCapability } from "../render/rendererCapability";
import { useRendererCapability } from "../render/useRendererCapability";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { usePreviewRenderTargetId } from "../state/compositionAnchorStore";
import { useLocalPlayheadUsThrottled } from "../state/playheadProjection";
import { compositionOrRoot, useProjectStore } from "../state/projectStore";

export function RendererLimitIndicator() {
  const cap = useRendererCapability();
  // A renderer that draws everything never subscribes to the playhead.
  if (!cap || DRAW_FEATURES.every((f) => cap.draws[f])) return null;
  return <LimitAtPlayhead cap={cap} />;
}

function LimitAtPlayhead({ cap }: { cap: RendererCapability }) {
  const { t } = useTranslation();
  const summary = useProjectStore((s) => s.summary);
  const compId = compositionOrRoot(summary, usePreviewRenderTargetId())?.id ?? null;
  const tUs = useLocalPlayheadUsThrottled(compId, 250);
  // Effects switched off for preview are a choice, not a loss.
  const effects = useAppSettingsStore((s) => s.settings.preview_effects_enabled);
  const refusal = useMemo(
    () => (summary && compId ? cannotDraw(cap, drawNeeds(summary, compId, tUs, tUs + 1, undefined, effects)) : null),
    [cap, summary, compId, tUs, effects],
  );
  if (!refusal) return null;
  const hint = t("preview.renderer_limit_hint", {
    renderer: refusal.renderer,
    features: refusal.missing.map((f) => t(`preview.renderer_feature_${f}`)).join(t("preview.renderer_feature_separator")),
  });
  return (
    <span className="renderer-limit-status" role="status" title={hint} aria-label={hint}>
      {t("preview.renderer_limit")}
    </span>
  );
}
