import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AppTimecodeField } from "../components/AppTimecodeField";
import { InspectorRow } from "./InspectorRow";
import type { LayerParamsPatch, LayerSummary } from "../ipc";

type FadeParams = Extract<LayerSummary["params"], { kind: "VideoClip" | "ImageOverlay" | "Audio" }>;

/** Edge durations edited on the composition's frame grid. */
export function FadeFields({ v, fpsNum, fpsDen, commit }: {
  v: FadeParams;
  fpsNum: number;
  fpsDen: number;
  commit: (patch: LayerParamsPatch) => Promise<void>;
}) {
  const { t } = useTranslation();
  const submitted = useRef({ fade_in_us: v.fade_in_us, fade_out_us: v.fade_out_us });
  useEffect(() => { submitted.current.fade_in_us = v.fade_in_us; }, [v.fade_in_us]);
  useEffect(() => { submitted.current.fade_out_us = v.fade_out_us; }, [v.fade_out_us]);
  const fields = [
    { key: "fade_in_us", label: "fade_in_duration" },
    { key: "fade_out_us", label: "fade_out_duration" },
  ] as const;

  return (
    <>
      {fields.map(({ key, label }) => (
        <InspectorRow key={key} label={t(`property_panel.${label}`)} reserveStopwatch>
          <AppTimecodeField
            valueUs={v[key]}
            fpsNum={fpsNum}
            fpsDen={fpsDen}
            ariaLabel={t(`property_panel.${label}`)}
            onCommit={(us) => {
              // Enter also blurs the control; submit only once before refresh.
              if (us === submitted.current[key]) return;
              submitted.current[key] = us;
              void commit({ kind: v.kind, [key]: us });
            }}
          />
        </InspectorRow>
      ))}
    </>
  );
}
