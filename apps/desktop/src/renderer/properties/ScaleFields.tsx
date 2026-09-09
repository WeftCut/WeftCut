import { useTranslation } from "react-i18next";
import { Link2, Link2Off } from "lucide-react";
import { tryMutate } from "../errors/tryMutate";
import { setScaleLinked, type LayerSummary } from "../ipc";
import { SCALE, SCALE_X, SCALE_Y } from "../keyframe/descriptors";
import { InspectorAnimField } from "./InspectorAnimField";
import { InspectorRow } from "./InspectorRow";

/// The scale block every transform-bearing section renders: ONE "Scale" row
/// either way — a single field + closed chain while linked, the X and Y axes
/// side by side + open chain while not. Closing the chain is silent and
/// destructive by design (the actor snaps scale_y := scale_x, keyframes
/// included — one commit, so one undo restores both track and flag).
///
/// The chain is the last child of the value column, after the field(s) it
/// governs, so a chain-bearing row is still one grid row on the panel's
/// single label edge.
export function ScaleFields({
  layer,
  scaleLinked,
  tInLayerUs,
  playheadInSpan,
  onMutated,
}: {
  layer: LayerSummary;
  scaleLinked: boolean;
  tInLayerUs: number;
  playheadInSpan: boolean;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toggleLabel = scaleLinked ? t("property_panel.scale_unlink") : t("property_panel.scale_link");
  const chain = (
    <button
      type="button"
      className={`scale-link-toggle ${scaleLinked ? "is-linked" : ""}`}
      aria-pressed={scaleLinked}
      aria-label={toggleLabel}
      title={toggleLabel}
      onClick={() => {
        void tryMutate(
          () => setScaleLinked(layer.id, !scaleLinked).then(onMutated),
          "Toggle scale link",
        );
      }}
    >
      {scaleLinked ? <Link2 size={12} aria-hidden /> : <Link2Off size={12} aria-hidden />}
    </button>
  );
  const axes = scaleLinked
    ? [SCALE]
    : [SCALE_X, SCALE_Y];
  return (
    <InspectorRow label={t("property_panel.scale")}>
      {axes.map((desc) => (
        <InspectorAnimField
          key={desc.labelKey}
          layer={layer}
          desc={desc}
          tInLayerUs={tInLayerUs}
          playheadInSpan={playheadInSpan}
          onMutated={onMutated}
          layout="cell"
        />
      ))}
      {chain}
    </InspectorRow>
  );
}
