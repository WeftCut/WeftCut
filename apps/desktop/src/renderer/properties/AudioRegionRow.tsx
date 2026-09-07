// The noise-profile sample region on a denoise card: the two bounds as source
// seconds, the arm button for the drag that paints them, and the one line that
// says why nothing is baking.
//
// Boundary: owns no gesture and no bake. Arming publishes to
// `timeline/audioRegionArmStore` (the drag itself is the timeline's), the band's
// visibility follows `state/audioRegionFocusStore` — which this row claims
// while it is on screen — and bake status is read from `state/audioFxStore`.
// See ADR 0063 and docs/audio.md § Clip effects.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type { AudioEffectRegion } from "../../shared/audioEffects/catalog";
import { AppNumberField } from "../components/AppNumberField";
import { tryMutate } from "../errors/tryMutate";
import {
  updateLayerParamTracks,
  type AnimTrack,
  type EffectView,
  type LayerSummary,
} from "../ipc";
import { useAudioFxError, useAudioFxStatus } from "../state/audioFxStore";
import {
  clearRegionFocus,
  setRegionFocus,
} from "../state/audioRegionFocusStore";
import {
  resolveHandleDrag,
  resolveRegionDrag,
  type RegionBound,
} from "../timeline/audioRegionGeometry";
import { armRegionSelect } from "../timeline/audioRegionArmStore";

const US_PER_SEC = 1_000_000;

/// Region bounds are authored in whole microseconds but read in seconds, so the
/// field shows three decimals — a millisecond, finer than any noise floor the
/// filter can resolve and coarse enough to be typeable.
const SECONDS_FORMAT: Intl.NumberFormatOptions = {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
};

/// A bound's stored value, or null when the key was never written. Absent IS
/// the unset state (the catalog's `staticParams` keeps region keys absent for
/// exactly this reason), so a `Keyframed` track — which the command layer
/// refuses on an `audio.*` param — reads unset rather than being sampled.
function storedBound(track: AnimTrack<number> | undefined): number | null {
  return track && track.mode === "Static" ? track.value : null;
}

/// The clip's window onto its media, in SOURCE time. Region bounds outside it
/// name audio this clip does not play, which is the one region mistake a trim
/// can introduce after the fact (the bake itself stays valid — bounds are source
/// time precisely so trim never invalidates it, spec Decision 3).
function sourceSpan(layer: LayerSummary): { startUs: number; endUs: number } {
  const startUs = "src_in_us" in layer.params ? layer.params.src_in_us : 0;
  return { startUs, endUs: startUs + (layer.t_end_us - layer.t_start_us) };
}

export function AudioRegionRow({
  layer,
  effect,
  region,
  onMutated,
}: {
  layer: LayerSummary;
  effect: EffectView;
  region: AudioEffectRegion;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const status = useAudioFxStatus(layer.id);
  const error = useAudioFxError(layer.id);

  // The band is drawable exactly while this row is on screen: the row lives in
  // the card body, which the collapse toggle unmounts, so mount/unmount already
  // IS "mounted and expanded" (spec Decision 12) and needs no second flag.
  useEffect(() => {
    setRegionFocus({ layerId: layer.id, effectId: effect.id });
    return () => clearRegionFocus(layer.id, effect.id);
  }, [layer.id, effect.id]);

  const inUs = storedBound(effect.params[region.inKey]);
  const outUs = storedBound(effect.params[region.outKey]);
  const span = sourceSpan(layer);

  /// The pair one typed bound produces.
  ///
  /// A field can only say one number, so the sibling either SURVIVES the edit —
  /// held `minUs` away and inside the clip's span, the same rule the band's
  /// handles obey — or is DERIVED from the typed bound when it is absent, stale
  /// (a trim moved the clip off it) or too crowded to leave room. Neither an
  /// inverted nor a too-short pair is ever written: both read as "no region" to
  /// the bake, so committing one would be a silent refusal.
  ///
  /// `null` when the clip plays less audio than the filter can learn from — no
  /// pair inside that span exists, and the arm button is already disabled there.
  const pairFromEdit = (
    bound: RegionBound,
    typedUs: number,
  ): { inUs: number; outUs: number } | null => {
    const clip = { tStartUs: span.startUs, tEndUs: span.endUs, minUs: region.minUs };
    const sibling = bound === "in" ? outUs : inUs;
    if (sibling !== null) {
      const movedUs = resolveHandleDrag({ ...clip, bound, newUs: typedUs, otherUs: sibling });
      const pair =
        bound === "in"
          ? { inUs: movedUs, outUs: sibling }
          : { inUs: sibling, outUs: movedUs };
      if (
        pair.outUs - pair.inUs >= region.minUs &&
        pair.inUs >= span.startUs &&
        pair.outUs <= span.endUs
      ) {
        return pair;
      }
    }
    // Grown away from the typed bound, exactly as the timeline's gesture grows a
    // too-short drag around its press point — so a first edit to either field
    // lands a whole region rather than a key its sibling cannot complete.
    return resolveRegionDrag({
      ...clip,
      pressUs: typedUs,
      releaseUs: bound === "in" ? typedUs : typedUs - 1,
    });
  };

  /// Both bounds, always, as ONE batch: an edit to either field is one undo
  /// entry, and a region typed into an empty card lands as a pair rather than a
  /// half-written key no second field could complete.
  const commit = (nextInUs: number, nextOutUs: number) => {
    const entries: [string, AnimTrack<number>][] = [
      [
        `effects[${effect.id}].params[${region.inKey}]`,
        { mode: "Static", value: nextInUs },
      ],
      [
        `effects[${effect.id}].params[${region.outKey}]`,
        { mode: "Static", value: nextOutUs },
      ],
    ];
    void tryMutate(
      () => updateLayerParamTracks(layer.id, entries).then(onMutated),
      "Edit sample region",
    );
  };

  /// One field's edit, as the whole pair it implies.
  const commitBound = (bound: RegionBound, typedUs: number) => {
    const pair = pairFromEdit(bound, typedUs);
    if (pair === null) return;
    commit(pair.inUs, pair.outUs);
  };

  const clipTooShort = layer.t_end_us - layer.t_start_us < region.minUs;

  /// Why nothing is baking, in the order the user can act on: a region problem
  /// keeps the effect out of the chain entirely, so it outranks any status the
  /// baker last published (which then describes a PREVIOUS region). Ready says
  /// nothing — the waveform and the sound are the confirmation.
  const stateLine = (): { text: string; failed: boolean } | null => {
    if (inUs === null || outUs === null) {
      return { text: t("effects.audio.region_needed"), failed: false };
    }
    if (outUs - inUs < region.minUs) {
      return { text: t("effects.audio.region_too_short"), failed: false };
    }
    if (outUs <= span.startUs || inUs >= span.endUs) {
      return { text: t("effects.audio.region_offscreen"), failed: false };
    }
    if (status === "failed") {
      return {
        text: t("effects.audio.status.failed", {
          error: error?.message ?? "",
        }),
        failed: true,
      };
    }
    if (status === "pending") {
      return { text: t("effects.audio.status.pending"), failed: false };
    }
    return null;
  };
  const line = stateLine();

  return (
    <>
      <div className="prop-field prop-effect-param" data-testid="audio-region-in">
        <span className="prop-field-label">{t("effects.audio.source_in")}</span>
        <div className="prop-field-control">
          <AppNumberField
            value={(inUs ?? 0) / US_PER_SEC}
            min={0}
            step={0.001}
            format={SECONDS_FORMAT}
            ariaLabel={t("effects.audio.source_in")}
            // Base UI self-buffers the typed text and commits on pause / blur /
            // Enter — the inspector-proven pattern, and the only one that keeps
            // one edit to one undo entry.
            onValueChange={() => {}}
            onCommit={(v) => commitBound("in", Math.round(v * US_PER_SEC))}
          />
        </div>
      </div>
      <div className="prop-field prop-effect-param" data-testid="audio-region-out">
        <span className="prop-field-label">{t("effects.audio.source_out")}</span>
        <div className="prop-field-control">
          <AppNumberField
            value={(outUs ?? 0) / US_PER_SEC}
            min={0}
            step={0.001}
            format={SECONDS_FORMAT}
            ariaLabel={t("effects.audio.source_out")}
            onValueChange={() => {}}
            onCommit={(v) => commitBound("out", Math.round(v * US_PER_SEC))}
          />
        </div>
      </div>
      <div className="prop-effect-add">
        <button
          type="button"
          className="effect-add-trigger"
          data-testid="audio-region-select"
          disabled={clipTooShort}
          {...(clipTooShort
            ? { title: t("effects.audio.select_region_too_short") }
            : {})}
          onClick={() =>
            armRegionSelect({
              layerId: layer.id,
              effectId: effect.id,
              inKey: region.inKey,
              outKey: region.outKey,
              minUs: region.minUs,
            })
          }
        >
          {t("effects.audio.select_region")}
        </button>
      </div>
      {line && (
        <p
          className={line.failed ? "settings-error" : "prop-effect-order-hint"}
          data-testid="audio-region-state"
        >
          {line.text}
        </p>
      )}
    </>
  );
}
