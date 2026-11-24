// Which catalog faces a Text layer draws with, and the `font-family` it draws
// under. Preview (Compositor, TextSprite, the inline editor), export
// (runExport, the Worker's TextSprite) and the properties panel's missing-font
// note all read these functions, so they cannot disagree about a layer's face.
// Matching itself is shared/fonts/resolve.ts; see docs/render.md "Fonts" and
// ADR 0176.

import { BUNDLED_FONT_FAMILIES, DEFAULT_CAPTION_FONT_FAMILY } from "../../../shared/fonts";
import { missingLeaves } from "../../../shared/fonts/missing";
import {
  faceAlias, isBundledFamily, isGenericFamily, parseFamilyList, requestItalic, requestWeight, resolveFace,
} from "../../../shared/fonts/resolve";
import type { FaceIndexEntry, FaceRef, FontIndex } from "../../../shared/fonts/types";
import type { Manifest } from "../../../shared/motifs/catalog";
import { motifFontSlots } from "../../../shared/motifs/fontProps";
import type { ProjectSummary } from "../../ipc";

/// The fields of a Text layer's params that choose its faces.
export interface TextFontRequest {
  font_family: string;
  weight: number;
  italic: boolean;
}

/// The faces of each family name in `index`, built once per index: a full
/// index holds every system face, and a summary resolves every Text leaf on
/// each publish.
const familyTables = new WeakMap<FontIndex, Map<string, FaceIndexEntry[]>>();

function familyTable(index: FontIndex): Map<string, FaceIndexEntry[]> {
  let table = familyTables.get(index);
  if (!table) {
    table = new Map();
    for (const face of index.faces) {
      for (const family of new Set(face.families.map(f => f.toLowerCase()))) {
        const list = table.get(family);
        if (list) list.push(face);
        else table.set(family, [face]);
      }
    }
    familyTables.set(index, table);
  }
  return table;
}

/// `resolveFace` over the faces naming `family` only: the same answer, since
/// it never looks at a face of another family and the table keeps index order.
function resolveLeaf(index: FontIndex, family: string, weight: number, italic: boolean): FaceIndexEntry | null {
  const faces = familyTable(index).get(family.toLowerCase());
  return faces ? resolveFace(faces, family, weight, italic) : null;
}

/// True when some face in `index` answers to `family`.
function familyKnown(index: FontIndex, family: string): boolean {
  return familyTable(index).has(family.toLowerCase());
}

function bundledName(family: string): string {
  const key = family.toLowerCase();
  return BUNDLED_FONT_FAMILIES.find(f => f.toLowerCase() === key) ?? family;
}

/// The leaves of a Text layer's family list that can draw: up to the first
/// generic one, which the bundled chain stands in for (a generic family would
/// draw a machine's own font, and the Worker cannot honour it). The project's
/// font walk (main/fonts/uses.ts) stops there too.
function drawableLeaves(text: TextFontRequest): string[] {
  const leaves = parseFamilyList(text.font_family);
  const generic = leaves.findIndex(isGenericFamily);
  return generic < 0 ? leaves : leaves.slice(0, generic);
}

/// The catalog face of each leaf of the layer's family list that resolves, in
/// list order. Bundled leaves are not in the catalog.
function resolvedFaces(text: TextFontRequest, index: FontIndex): FaceIndexEntry[] {
  const out: FaceIndexEntry[] = [];
  for (const leaf of drawableLeaves(text)) {
    if (isBundledFamily(leaf)) continue;
    const face = resolveLeaf(index, leaf, requestWeight(text.weight), requestItalic(text.italic));
    if (face) out.push(face);
  }
  return out;
}

/// The `font-family` a Text layer draws under: each leaf's resolved face as
/// its alias (`faceAlias`), bundled leaves by name, both in list order, then
/// the bundled default chain. A leaf that resolves nowhere is left out, so the
/// next one draws; the bundled tail covers every glyph the faces before it
/// lack, and draws in place of a generic leaf (`drawableLeaves`).
export function renderFamilyStack(text: TextFontRequest, index: FontIndex): string {
  const stack: string[] = [];
  const add = (name: string) => {
    if (!stack.includes(name)) stack.push(name);
  };
  for (const leaf of drawableLeaves(text)) {
    if (isBundledFamily(leaf)) add(bundledName(leaf));
    else {
      const face = resolveLeaf(index, leaf, requestWeight(text.weight), requestItalic(text.italic));
      if (face) add(faceAlias(face.sha256));
    }
  }
  for (const family of parseFamilyList(DEFAULT_CAPTION_FONT_FAMILY)) add(family);
  return stack.join(", ");
}

/// Every catalog face the summary's Text layers resolve to, in every
/// composition and including disabled layers and tracks, sorted by hash.
/// Preview registers exactly these and the export Worker receives exactly
/// these: an enabled layer must not wait for a face, and one list for both
/// keeps them drawing alike.
export function textFaceRefs(summary: ProjectSummary, index: FontIndex): FaceRef[] {
  const refs = new Map<string, FaceRef>();
  for (const composition of Object.values(summary.compositions)) {
    for (const track of composition.tracks) {
      for (const layer of track.layers) {
        if (layer.params.kind !== "Text") continue;
        for (const face of resolvedFaces(layer.params, index)) {
          refs.set(face.sha256, { sha256: face.sha256, weight: face.weight, italic: face.italic });
        }
      }
    }
  }
  return [...refs.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
}

/// A family the layer names that draws nowhere on this machine, and what
/// draws instead.
export interface MissingFont {
  family: string;
  /// The style the layer asks of it, e.g. "Bold Italic"; null for a Motif
  /// prop, whose CSS picks the weight.
  style: string | null;
  /// The family that draws in its place: the next leaf that draws, else the
  /// bundled chain for Text and null for a Motif (the capture browser's own
  /// default).
  fallback: string | null;
}

const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium",
  600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black",
};

/// "Bold Italic", "Regular", "Italic", "650": the name a font menu gives the
/// style.
function styleName(weight: number, italic: boolean): string {
  const w = requestWeight(weight);
  const name = WEIGHT_NAMES[w] ?? String(w);
  if (!requestItalic(italic)) return name;
  return w === 400 ? "Italic" : `${name} Italic`;
}

/// The missing leaves of a Text layer's family list, by the rule main names
/// them by (shared/fonts/missing.ts). Empty until the index is `complete`: a
/// family missing before then may only be unindexed.
export function missingTextFonts(text: TextFontRequest, index: FontIndex): MissingFont[] {
  if (!index.complete) return [];
  const { missing, fallback } = missingLeaves(parseFamilyList(text.font_family), (leaf) => familyKnown(index, leaf));
  // A generic leaf draws as the bundled chain (`drawableLeaves`).
  const drawn = fallback === null || isGenericFamily(fallback) ? DEFAULT_CAPTION_FONT_FAMILY
    : isBundledFamily(fallback) ? bundledName(fallback) : fallback;
  return missing.map(family => ({ family, style: styleName(text.weight, text.italic), fallback: drawn }));
}

/// The missing leaves of a Motif layer's font slots (the layer's value, else
/// the manifest's default), by the rule main names them by
/// (shared/fonts/missing.ts); the families its package ships draw. Empty
/// until the index is `complete`.
export function missingMotifFonts(
  manifest: Pick<Manifest, "props_schema" | "fonts">,
  props: Readonly<Record<string, unknown>>,
  index: FontIndex,
): MissingFont[] {
  if (!index.complete) return [];
  const shipped = new Set((manifest.fonts ?? []).map(f => f.family.trim().toLowerCase()));
  const out: MissingFont[] = [];
  const seen = new Set<string>();
  for (const { css } of motifFontSlots(manifest, props)) {
    const { missing, fallback } = missingLeaves(parseFamilyList(css), (leaf) => shipped.has(leaf.toLowerCase()) || familyKnown(index, leaf));
    for (const family of missing) {
      if (seen.has(family.toLowerCase())) continue;
      seen.add(family.toLowerCase());
      out.push({ family, style: null, fallback });
    }
  }
  return out;
}
