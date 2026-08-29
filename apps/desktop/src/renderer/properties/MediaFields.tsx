import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { formatMediaDuration } from "../frames";
import type { MediaSummary } from "../ipc";
import {
  mediaReferenceMeta,
  mediaReferencesFor,
} from "../panels/mediaReferences";
import { quickProxyPath } from "../render/decodeRoute";
import { jumpToLayer } from "../state/navigation";
import { useGroupOrdinals, useProjectSummary } from "../state/projectStore";
import { Field } from "./Field";
import { PropSection } from "./PropSection";

/// What a field prints when the summary carries no answer. A dash, not a blank
/// row: "we don't know" and "the row isn't there" are different statements.
const ABSENT = "—";

/// Collapse memory is keyed `${layerKind}:${sectionId}`, and a media item has no
/// layer kind. One namespace for all media, so the sections a user collapsed
/// stay collapsed as they click from clip to clip.
const SECTION_KIND = "Media";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/// Bytes as the largest unit that keeps the number under 1024. No shared
/// formatter exists in the renderer; this is the app's only file-size readout.
function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit] ?? BYTE_UNITS[0]}`;
}

/// Read-only description of a media item, for the pool card the user picked.
///
/// Read-only on purpose: proxy override and shot analysis stay in the pool's
/// context menu, because a setting reachable from two places has no
/// authoritative home (`.scratch/pool-unification/spec.md`). Everything here
/// comes off the `MediaSummary` the store already holds — no probe, no command.
///
/// `fpsNum`/`fpsDen` are the panel's, and they format the usage list's
/// timecodes; see `mediaReferenceMeta` for why one rate serves every
/// composition.
export function MediaFields({
  media,
  fpsNum,
  fpsDen,
}: {
  media: MediaSummary;
  fpsNum: number;
  fpsDen: number;
}) {
  const { t } = useTranslation();
  const summary = useProjectSummary();
  const ordinals = useGroupOrdinals();
  const references = useMemo(
    () => mediaReferencesFor(media.id, summary, ordinals, t),
    [media.id, summary, ordinals, t],
  );

  const kindLabel = t(`kinds.${media.kind.toLowerCase()}`, {
    defaultValue: media.kind,
  });
  const resolution =
    media.width !== null && media.height !== null
      ? `${media.width}×${media.height}`
      : ABSENT;
  const colorTags = [
    media.color_matrix,
    media.color_range,
    media.color_primaries,
    media.color_transfer,
  ].filter((tag): tag is string => typeof tag === "string" && tag !== "");

  const route = media.decode_route.route;
  // Bypass is the one route with no proxy slot at all, so it is also the one
  // with no readiness to report.
  const proxyReadiness =
    route === "bypass"
      ? null
      : t(
          quickProxyPath(media) === null
            ? "property_panel.media_proxy_pending"
            : "property_panel.media_proxy_ready",
        );
  const routeLabel = t(`property_panel.media_route_${route.replace("-", "_")}`);

  return (
    <>
      <div className="prop-identity">
        <p className="prop-identity-title" title={media.label}>
          {media.label}
        </p>
        <p className="prop-identity-meta">
          {media.available
            ? kindLabel
            : `${kindLabel} · ${t("media_pool.missing")}`}
        </p>
      </div>
      <PropSection
        layerKind={SECTION_KIND}
        sectionId="media"
        title={t("property_panel.media")}
      >
        <Field label={t("property_panel.kind")}>
          <span className="text-xs text-muted-foreground">{kindLabel}</span>
        </Field>
        <Field label={t("property_panel.duration")}>
          <span className="font-mono text-xs text-muted-foreground">
            {media.duration_us === null
              ? ABSENT
              : formatMediaDuration(media.duration_us)}
          </span>
        </Field>
        <Field label={t("property_panel.media_resolution")}>
          <span className="text-xs text-muted-foreground">{resolution}</span>
        </Field>
        <Field label={t("property_panel.media_size")}>
          <span className="text-xs text-muted-foreground">
            {formatBytes(media.size_bytes)}
          </span>
        </Field>
        {/* The full path is the title, because the row can only ever show its
            tail and a missing source is identified by where it was. */}
        <Field label={t("property_panel.media_location")}>
          <span
            className="block truncate text-xs text-muted-foreground"
            title={media.path}
          >
            {media.path}
          </span>
        </Field>
      </PropSection>
      <PropSection
        layerKind={SECTION_KIND}
        sectionId="decode"
        title={t("property_panel.media_decode")}
      >
        <Field label={t("media_pool.proxy_heading")}>
          <span className="text-xs text-muted-foreground">
            {proxyReadiness === null
              ? routeLabel
              : `${routeLabel} · ${proxyReadiness}`}
          </span>
        </Field>
        <Field label={t("property_panel.media_codec")}>
          <span className="text-xs text-muted-foreground">
            {media.codec ?? ABSENT}
          </span>
        </Field>
        <Field label={t("property_panel.media_pix_fmt")}>
          <span className="text-xs text-muted-foreground">
            {media.pix_fmt ?? ABSENT}
          </span>
        </Field>
        {/* Absent for audio and for older summaries alike, and four "—" rows
            would say nothing four times. */}
        {colorTags.length > 0 && (
          <Field label={t("property_panel.media_color")}>
            <span className="text-xs text-muted-foreground">
              {colorTags.join(" · ")}
            </span>
          </Field>
        )}
      </PropSection>
      <PropSection
        layerKind={SECTION_KIND}
        sectionId="usage"
        title={t("property_panel.media_usage")}
      >
        {references.length === 0 ? (
          // Not a warning: everything in the pool is unused the moment it is
          // imported, and a B-roll alternative can stay unused forever.
          <p className="placeholder">{t("property_panel.media_unused")}</p>
        ) : (
          <ul className="prop-media-refs">
            {references.map((reference) => (
              <li key={reference.layerId}>
                <button
                  type="button"
                  className="prop-media-ref"
                  title={t("property_panel.media_usage_go")}
                  onClick={() => {
                    jumpToLayer(reference.layerId);
                  }}
                >
                  <span className="prop-media-ref-name">{reference.name}</span>
                  <span className="prop-media-ref-meta">
                    {mediaReferenceMeta(reference, fpsNum, fpsDen)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PropSection>
    </>
  );
}
