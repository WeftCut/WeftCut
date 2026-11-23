// Font slots: a Motif `string` prop named `font_<slot>` whose value is a CSS
// `font-family` stack (docs/motif-authoring.md § Font slots). The style layer
// fills it from a taste's font tokens (main/taste/motifProps.ts); the Motif
// forms edit it with a font picker (renderer/properties/MotifPropFields.tsx).

import type { PropSpec } from "./catalog";

export function isFontSlot(key: string, spec: PropSpec): boolean {
  return key.startsWith("font_") && spec.type === "string";
}

/** Families as a `font-family` value, each one quoted: `'Anton', 'Impact'`. */
export function formatFontStack(families: readonly string[]): string {
  return families.map((f) => `'${f.replace(/[\\']/g, "\\$&")}'`).join(", ");
}

/** The family a stack names when it names exactly one, quoted or bare; else null. */
export function singleFontFamily(stack: string): string | null {
  const m = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^,'"]+?))\s*$/.exec(stack);
  if (!m) return null;
  const family = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  return family === "" ? null : family;
}
