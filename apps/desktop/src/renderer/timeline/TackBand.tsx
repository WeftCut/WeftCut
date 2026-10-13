import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatTimecode } from "../frames";
import { getCommand } from "../commands/registry";
import { useComposition } from "../state/projectStore";
import { useAgentActivity } from "../agent/activityStore";
import { useCompositionTacks } from "../agent/tackModel";
import { computeLaneTacks } from "./rulerModel";

/// The Review overlay's layer in the marker lane (ADR 0115): open tack ranges
/// as a band BEHIND the markers.
///
/// Painted inside the lane's own box, absolutely, so turning the overlay on or
/// off adds no row and changes no height — the lane is the ruler family's row,
/// and a reflow under the pointer is exactly what CONTEXT.md's *Marker lane*
/// forbids. Rendered before the marker layer, so a marker glyph stacks above a
/// band and keeps its drag and menu; a press that misses every glyph lands on
/// the band and selects the tack in the agent panel. It never seeks: the ruler
/// stays the sole scrub surface.
///
/// The lane exists only while `markers_visible` is on, so with markers hidden
/// there is nowhere for the band to paint — hiding the row hides its overlay.
export function TackBand({
  compositionId,
  pxPerSec,
  scrollLeftPx,
  viewportWidthPx,
  fpsNum,
  fpsDen,
}: {
  compositionId: string | null;
  pxPerSec: number;
  scrollLeftPx: number;
  viewportWidthPx: number;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const overlay = useAgentActivity((s) => s.reviewOverlay);
  const selected = useAgentActivity((s) => s.selectedTack);
  // `compositionId` null names the root, as everywhere on the timeline; tacks
  // carry the concrete id.
  const resolvedId = useComposition(compositionId)?.id ?? null;
  const tacks = useCompositionTacks(overlay ? resolvedId : null);
  const views = useMemo(
    () =>
      computeLaneTacks({ tacks, pxPerSec, scrollLeftPx, viewportWidthPx }).map((view) => ({
        view,
        title: t("tacks.band_tooltip", {
          label: view.label,
          time:
            formatTimecode(view.tUs, fpsNum, fpsDen) +
            (view.endTUs === null ? "" : ` – ${formatTimecode(view.endTUs, fpsNum, fpsDen)}`),
        }),
      })),
    [tacks, pxPerSec, scrollLeftPx, viewportWidthPx, fpsNum, fpsDen, t],
  );
  if (views.length === 0) return null;
  const select = (id: string) => {
    useAgentActivity.getState().selectTack(id);
    void getCommand("openAgentPanel")?.run();
  };
  return (
    <div data-testid="timeline-tack-layer" className="pointer-events-none absolute inset-0">
      {views.map(({ view, title }) => (
        <div
          key={view.id}
          data-testid="timeline-tack"
          data-tack-id={view.id}
          data-selected={selected === view.id ? "true" : undefined}
          title={title}
          className="pointer-events-auto absolute inset-y-0 cursor-pointer"
          style={{
            left: view.xPx,
            width: view.widthPx,
            background: `color-mix(in srgb, var(--tack) ${selected === view.id ? 40 : 20}%, transparent)`,
            borderTop: "2px solid var(--tack)",
          }}
          onClick={() => select(view.id)}
        />
      ))}
    </div>
  );
}
