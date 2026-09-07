// Contextual per-Layer effect-chain Panel. This boundary owns the chain and
// nothing else; kind-specific Layer fields remain in AttributePanel.
//
// Which catalog a layer edits is decided HERE, once: an Audio layer's effects
// are offline bakes (`src/shared/audioEffects`, ADR 0063) and a visual layer's
// are realtime Pixi filters. Two lifecycles, one card surface.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { type TrackSummary } from "../ipc";
import {
  audioCatalogForUi,
  EffectsSection,
} from "../properties/EffectsSection";
import { listEffects } from "../render/effects/effectRegistry";
import { findPanelLayer } from "./panelLayer";

export interface EffectPanelProps {
  tracks: TrackSummary[];
  selectedLayerId: string | null;
  currentTimeUs: number;
  onMutated: () => Promise<void>;
}

export function EffectPanel({
  tracks,
  selectedLayerId,
  currentTimeUs,
  onMutated,
}: EffectPanelProps) {
  const { t } = useTranslation();
  // A scan of every track's layers, so it is memoised rather than re-run on
  // each unrelated re-render — the same shape `AttributePanel` uses.
  const layer = useMemo(
    () => findPanelLayer(tracks, selectedLayerId),
    [tracks, selectedLayerId],
  );

  // An empty selection gets an explicit Panel body, so the chain is never an
  // unexplained blank area.
  if (!layer) {
    return (
      <aside
        className="property-panel effect-panel"
        aria-label={t("effects.heading")}
      >
        <p className="placeholder">{t("effects.empty")}</p>
      </aside>
    );
  }

  const tInLayerUs = currentTimeUs - layer.t_start_us;
  const playheadInSpan =
    currentTimeUs >= layer.t_start_us && currentTimeUs < layer.t_end_us;

  return (
    <aside
      className="property-panel effect-panel"
      aria-label={t("effects.heading")}
    >
      <EffectsSection
        layer={layer}
        catalog={layer.params.kind === "Audio" ? audioCatalogForUi : listEffects()}
        tInLayerUs={tInLayerUs}
        playheadInSpan={playheadInSpan}
        onMutated={onMutated}
      />
    </aside>
  );
}
