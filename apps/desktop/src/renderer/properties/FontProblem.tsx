// The properties panel's note for a family a layer names that draws nowhere on
// this machine, and what draws instead (ADR 0176). The missing set comes from
// render/fonts/textFaces.ts, the functions that choose what preview and export
// draw.
import { useTranslation } from "react-i18next";

import type { Manifest } from "../../shared/motifs/catalog";
import { useFontIndex } from "../render/fonts/fontIndexStore";
import { missingMotifFonts, missingTextFonts, type MissingFont, type TextFontRequest } from "../render/fonts/textFaces";

function FontProblem({ missing }: { missing: MissingFont[] }) {
  const { t } = useTranslation();
  if (missing.length === 0) return null;
  return (
    <>
      {missing.map((m) => (
        <p key={m.family.toLowerCase()} className="settings-warn" data-testid="font-problem">
          {m.style !== null
            ? t("property_panel.font_missing", { family: m.family, style: m.style, fallback: m.fallback })
            : m.fallback !== null
              ? t("property_panel.font_missing", { context: "motif", family: m.family, fallback: m.fallback })
              : t("property_panel.font_missing", { context: "motif_default", family: m.family })}
        </p>
      ))}
    </>
  );
}

/// Under a Text layer's Font family.
export function TextFontProblem({ text }: { text: TextFontRequest }) {
  return <FontProblem missing={missingTextFonts(text, useFontIndex())} />;
}

/// Under a Motif's props: its font slots, less the families its package ships.
export function MotifFontProblem({ manifest, props }: {
  manifest: Pick<Manifest, "props_schema" | "fonts">;
  props: Readonly<Record<string, unknown>>;
}) {
  return <FontProblem missing={missingMotifFonts(manifest, props, useFontIndex())} />;
}
