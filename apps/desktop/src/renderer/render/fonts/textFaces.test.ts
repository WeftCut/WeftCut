import { describe, expect, it } from "vitest";

import { DEFAULT_CAPTION_FONT_FAMILY } from "../../../shared/fonts";
import { faceAlias } from "../../../shared/fonts/resolve";
import type { FaceIndexEntry, FontIndex } from "../../../shared/fonts/types";
import type { ProjectSummary } from "../../ipc";
import { missingMotifFonts, missingTextFonts, renderFamilyStack, textFaceRefs } from "./textFaces";

function face(families: string[], weight: FaceIndexEntry["weight"], italic: boolean, sha: string, source: FaceIndexEntry["source"] = "system"): FaceIndexEntry {
  return { families, weight, italic, source, sha256: sha.repeat(64 / sha.length), size: 1, ttcIndex: null };
}

const regular = face(["Example Sans"], 400, false, "a1");
const bold = face(["Example Sans"], 700, false, "b2");
const variable = face(["Flex Serif"], [100, 900], false, "c3");
const projectRegular = face(["Example Sans"], 400, false, "d4", "project");

function index(faces: FaceIndexEntry[], systemScanned = true): FontIndex {
  return { revision: 1, systemScanned, faces };
}

const BUNDLED_TAIL = `, ${DEFAULT_CAPTION_FONT_FAMILY}`;

type Text = { font_family: string; weight: number; italic: boolean; enabled?: boolean };

/// A root holding the given Text layers on one track, and a Group composition
/// holding one more.
function summary(root: Text[], group: Text[] = []): ProjectSummary {
  const layer = (t: Text, i: number, prefix: string) => ({
    id: `${prefix}${i}`,
    enabled: t.enabled ?? true,
    params: { kind: "Text", content: "Aa", font_family: t.font_family, weight: t.weight, italic: t.italic },
  });
  return {
    root_id: "root",
    compositions: {
      root: { id: "root", tracks: [{ enabled: true, layers: root.map((t, i) => layer(t, i, "r")) }] },
      group: { id: "group", tracks: [{ enabled: false, layers: group.map((t, i) => layer(t, i, "g")) }] },
    },
  } as unknown as ProjectSummary;
}

describe("textFaceRefs and renderFamilyStack", () => {
  it("name the same faces: every alias a stack draws under is a face the refs register", () => {
    // Preview registers `textFaceRefs` and export sends its Worker the same
    // list; both draw `renderFamilyStack`. A stack alias outside the refs
    // would draw a fallback in one and not be caught by the other.
    const idx = index([regular, bold, variable]);
    const texts: Text[] = [
      { font_family: "Example Sans", weight: 700, italic: false },
      { font_family: "Missing Face, Flex Serif", weight: 600, italic: false },
      { font_family: "Example Sans", weight: 400, italic: true, enabled: false },
    ];
    const s = summary(texts.slice(0, 2), texts.slice(2));
    const registered = new Set(textFaceRefs(s, idx).map(r => faceAlias(r.sha256)));
    const drawn = texts.flatMap(t => renderFamilyStack(t, idx).split(", ").filter(n => n.startsWith("wf-")));
    expect(new Set(drawn)).toEqual(registered);
  });

  it("covers disabled layers and every composition, so enabling one never waits for a face", () => {
    const s = summary([], [{ font_family: "Flex Serif", weight: 400, italic: false, enabled: false }]);
    expect(textFaceRefs(s, index([variable])).map(r => r.sha256)).toEqual([variable.sha256]);
  });

  it("registers a Bold layer's 700 face with its weight", () => {
    const s = summary([{ font_family: "Example Sans", weight: 700, italic: false }]);
    expect(textFaceRefs(s, index([regular, bold]))).toEqual([{ sha256: bold.sha256, weight: 700, italic: false }]);
  });

  it("carries a variable face's weight range", () => {
    const s = summary([{ font_family: "Flex Serif", weight: 650, italic: false }]);
    expect(textFaceRefs(s, index([variable]))).toEqual([{ sha256: variable.sha256, weight: [100, 900], italic: false }]);
  });

  it("prefers the project's face of a family over the system's", () => {
    const text = { font_family: "Example Sans", weight: 400, italic: false };
    expect(renderFamilyStack(text, index([regular, projectRegular]))).toBe(faceAlias(projectRegular.sha256) + BUNDLED_TAIL);
  });

  it("keeps bundled leaves in place and drops generic ones", () => {
    const text = { font_family: "Noto Sans SC, Example Sans, sans-serif", weight: 400, italic: false };
    expect(renderFamilyStack(text, index([regular]))).toBe(`Noto Sans SC, ${faceAlias(regular.sha256)}, Liberation Sans`);
  });

  it("ends the stack at a generic leaf: the bundled chain draws in its place, not the leaves after it", () => {
    const text = { font_family: "Example Sans, sans-serif, Flex Serif", weight: 400, italic: false };
    const idx = index([regular, variable]);
    expect(renderFamilyStack(text, idx)).toBe(faceAlias(regular.sha256) + BUNDLED_TAIL);
    expect(textFaceRefs(summary([text]), idx).map(r => r.sha256)).toEqual([regular.sha256]);
  });

  it("ends a stack whose leaves all miss in the bundled chain", () => {
    const text = { font_family: "Missing Face", weight: 400, italic: false };
    expect(renderFamilyStack(text, index([regular]))).toBe(DEFAULT_CAPTION_FONT_FAMILY);
  });
});

describe("missingTextFonts", () => {
  it("names each leaf that resolves nowhere, its style, and the next leaf that draws", () => {
    const text = { font_family: "Missing Face, Example Sans", weight: 700, italic: true };
    expect(missingTextFonts(text, index([regular]))).toEqual([
      { family: "Missing Face", style: "Bold Italic", fallback: "Example Sans" },
    ]);
  });

  it("names the bundled chain when no later leaf draws", () => {
    const text = { font_family: "Example Sans, Missing Face", weight: 400, italic: false };
    expect(missingTextFonts(text, index([]))).toEqual([
      { family: "Example Sans", style: "Regular", fallback: DEFAULT_CAPTION_FONT_FAMILY },
      { family: "Missing Face", style: "Regular", fallback: DEFAULT_CAPTION_FONT_FAMILY },
    ]);
  });

  it("is silent while the system scan is pending", () => {
    const text = { font_family: "Missing Face", weight: 400, italic: false };
    expect(missingTextFonts(text, index([], false))).toEqual([]);
  });

  it("never reports bundled or generic families", () => {
    const text = { font_family: "Liberation Sans, serif", weight: 400, italic: false };
    expect(missingTextFonts(text, index([]))).toEqual([]);
    expect(missingTextFonts({ font_family: "sans-serif, Missing Face", weight: 400, italic: false }, index([]))).toEqual([]);
  });

  it("follows the shared rule: a leaf after the first that resolves is never missing", () => {
    const text = { font_family: "Missing Face, Example Sans, Later Missing", weight: 400, italic: false };
    expect(missingTextFonts(text, index([regular])).map(m => m.family)).toEqual(["Missing Face"]);
  });

  it("names the bundled chain when a generic leaf is the first that draws", () => {
    const text = { font_family: "Missing Face, serif", weight: 0, italic: false };
    expect(missingTextFonts(text, index([]))).toEqual([
      { family: "Missing Face", style: "Regular", fallback: DEFAULT_CAPTION_FONT_FAMILY },
    ]);
  });
});

describe("missingMotifFonts", () => {
  const manifest = (fonts: string[] = []) => ({
    props_schema: {
      font_title: { type: "string" as const, default: "'Default Missing', serif" },
      font_body: { type: "string" as const, default: "Example Sans" },
      title: { type: "string" as const, default: "Missing Face" },
    },
    fonts: fonts.map(family => ({ family, file: "x.woff2" })),
  });

  it("skips the families the package ships, and names the leaf that draws instead", () => {
    const props = { font_title: "'Missing Face', 'Shipped Sans', Later Missing", title: "Not A Font" };
    expect(missingMotifFonts(manifest(["Shipped Sans"]), props, index([regular]))).toEqual([
      { family: "Missing Face", style: null, fallback: "Shipped Sans" },
    ]);
  });

  it("reads a slot the layer leaves unset from the manifest's default", () => {
    expect(missingMotifFonts(manifest(), {}, index([regular]))).toEqual([
      { family: "Default Missing", style: null, fallback: "serif" },
    ]);
  });

  it("has no fallback when no leaf draws", () => {
    expect(missingMotifFonts(manifest(), { font_title: "Missing Face", font_body: "Missing Face" }, index([]))).toEqual([
      { family: "Missing Face", style: null, fallback: null },
    ]);
  });
});
