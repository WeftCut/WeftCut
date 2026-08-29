import { describe, expect, it } from "vitest";
import { groupDisplayName, groupOrdinals, layerDisplayName } from "./layerName";
import { TEXT_NAME_MAX } from "../../shared/textSnippet";
import en from "../i18n/locales/en-US";
import zh from "../i18n/locales/zh-CN";
import type {
  AnimTrack,
  CompositionSummary,
  LayerSummary,
  Rgba,
} from "../ipc";

const num = (value: number): AnimTrack<number> => ({ mode: "Static", value });
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/// The same five-line i18next as trackName.test.ts's: dotted lookup plus
/// `{{name}}` substitution over the real locale bundles. Asserting the shipped
/// strings is the point — "the kind rung reads as 文本 in zh-CN" is not provable
/// against a stub that echoes its key.
const translator =
  (locale: unknown) =>
  (key: string, values: Record<string, unknown>): string => {
    const raw = key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        locale,
      );
    if (typeof raw !== "string") return String(values.defaultValue ?? key);
    return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      String(values[name]),
    );
  };
const tEn = translator(en);
const tZh = translator(zh);

function textLayer(content: string, label: string | null = null): LayerSummary {
  return {
    id: "L-text",
    label,
    t_start_us: 0,
    t_end_us: 1_000_000,
    kind: "Text",
    color_hint: "#b17bc1",
    enabled: true,
    locked: false,
    params: {
      kind: "Text",
      content,
      font_family: "Inter",
      font_size_px: 48,
      weight: 400,
      italic: false,
      align: "Center",
      anchor_x: num(0.5),
      anchor_y: num(0.5),
      color: { mode: "Static", value: WHITE },
      x: num(0),
      y: num(0),
      scale_x: num(1),
      scale_y: num(1),
      scale_linked: true,
      rotation_deg: num(0),
      opacity: num(1),
      outline: null,
      shadow: null,
      box_w: null,
      box_h: null,
      valign: "Middle",
      line_height: 0,
      letter_spacing: 0,
    },
    effects: [],
  };
}

function videoLayer(
  mediaLabel: string,
  label: string | null = null,
): LayerSummary {
  return {
    id: "L-video",
    label,
    t_start_us: 0,
    t_end_us: 1_000_000,
    kind: "VideoClip",
    color_hint: "#446688",
    enabled: true,
    locked: false,
    params: {
      kind: "VideoClip",
      media_id: "M1",
      media_label: mediaLabel,
      src_in_us: 0,
      src_out_us: 1_000_000,
      x: num(0),
      y: num(0),
      scale_x: num(1),
      scale_y: num(1),
      scale_linked: true,
      rotation_deg: num(0),
      anchor_x: num(0.5),
      anchor_y: num(0.5),
      opacity: num(1),
      speed: 1,
      flip_h: false,
      flip_v: false,
      fade_in_us: 0,
      fade_out_us: 0,
    },
    effects: [],
  };
}

function groupLayer(
  compositionId: string,
  compositionLabel: string | null,
  label: string | null = null,
): LayerSummary {
  return {
    id: `L-${compositionId}`,
    label,
    t_start_us: 0,
    t_end_us: 1_000_000,
    kind: "CompositionRef",
    color_hint: "#8a94a0",
    enabled: true,
    locked: false,
    params: {
      kind: "CompositionRef",
      composition_id: compositionId,
      composition_label: compositionLabel,
      src_in_us: 0,
      src_out_us: 1_000_000,
      x: num(0),
      y: num(0),
      scale_x: num(1),
      scale_y: num(1),
      scale_linked: true,
      rotation_deg: num(0),
      anchor_x: num(0.5),
      anchor_y: num(0.5),
      opacity: num(1),
    },
    effects: [],
  };
}

/// Only the field the ordinals read. Key order is deliberately NOT meaningful
/// here — the number comes off the composition, not off its position.
const comps = (
  ...entries: Array<[string, number]>
): Record<string, Pick<CompositionSummary, "id" | "ordinal">> =>
  Object.fromEntries(entries.map(([id, ordinal]) => [id, { id, ordinal }]));

describe("groupOrdinals", () => {
  it("reads the stored number off each composition, root excluded", () => {
    const ordinals = groupOrdinals(
      comps(["root", 0], ["g-a", 1], ["g-b", 2]),
      "root",
    );
    expect(ordinals.get("root")).toBeUndefined();
    expect(ordinals.get("g-a")).toBe(1);
    expect(ordinals.get("g-b")).toBe(2);
  });

  // The counter is monotonic, so deleting a Group leaves a hole rather than
  // pulling its successors down. A number is a name, not an index.
  it("keeps the gaps a deleted Group leaves behind", () => {
    const ordinals = groupOrdinals(comps(["root", 0], ["g-a", 1], ["g-c", 3]), "root");
    expect(ordinals.get("g-a")).toBe(1);
    expect(ordinals.get("g-c")).toBe(3);
  });

  // The number is independent of the label, which is what makes naming one
  // Group leave every other Group's displayed name alone — and what lets a
  // cleared label fall back to the number the Group always had.
  it("numbers a labelled Group too", () => {
    const ordinals = groupOrdinals(comps(["root", 0], ["g-a", 1], ["g-b", 2]), "root");
    expect(groupDisplayName("g-a", "Lower third", ordinals, tEn)).toBe("Lower third");
    expect(groupDisplayName("g-b", null, ordinals, tEn)).toBe("Group 2");
    // Clearing g-a's label restores its own number, not g-b's.
    expect(groupDisplayName("g-a", null, ordinals, tEn)).toBe("Group 1");
  });
});

describe("groupDisplayName", () => {
  it("prefers the composition's stored label", () => {
    expect(groupDisplayName("g-a", "Lower third", new Map(), tEn)).toBe(
      "Lower third",
    );
  });

  it("derives a localised number from the ordinals", () => {
    const ordinals = new Map([["g-a", 2]]);
    expect(groupDisplayName("g-a", null, ordinals, tEn)).toBe("Group 2");
    expect(groupDisplayName("g-a", null, ordinals, tZh)).toBe("组 2");
  });

  // An ordinal map built from an older summary knows nothing about a Group
  // created since. The bare kind word is the honest answer — a wrong number
  // would name it after some other Group.
  it("falls back to the kind word with no ordinal to spend", () => {
    expect(groupDisplayName("g-new", null, new Map(), tEn)).toBe("Group");
    expect(groupDisplayName("g-new", null, undefined, tZh)).toBe("组");
  });
});

describe("layerDisplayName", () => {
  it("prefers the layer's own label over every derived rung", () => {
    expect(layerDisplayName(videoLayer("beach.mp4", "Opening shot"), tEn)).toBe(
      "Opening shot",
    );
    expect(layerDisplayName(textLayer("Hello world", "Title card"), tEn)).toBe(
      "Title card",
    );
    // A stored label is user content: it reads the same in every locale.
    expect(layerDisplayName(textLayer("Hello world", "Title card"), tZh)).toBe(
      "Title card",
    );
  });

  it("falls back to the media label for a clip that has one", () => {
    expect(layerDisplayName(videoLayer("beach.mp4"), tEn)).toBe("beach.mp4");
  });

  // Nothing in the app writes a Text layer's label — `applyAddLayer` stores
  // `label: null` and an .srt import runs it per cue — so without this rung a
  // caption track is a hundred blocks all reading "Text".
  it("names an unlabelled Text layer by the words it renders", () => {
    expect(layerDisplayName(textLayer("Once upon a time"), tEn)).toBe(
      "Once upon a time",
    );
    // Content is user text too: no locale turns it into anything else.
    expect(layerDisplayName(textLayer("从前有座山"), tZh)).toBe("从前有座山");
  });

  // A caption is routinely two or three lines. Naming it by its raw content
  // would put a newline into a one-row chip, a history row and a tooltip.
  it("collapses newlines and whitespace runs into one line", () => {
    expect(layerDisplayName(textLayer("first line\nsecond line"), tEn)).toBe(
      "first line second line",
    );
    expect(layerDisplayName(textLayer("  spaced   out \t"), tEn)).toBe(
      "spaced out",
    );
  });

  // The cap is on what comes BACK, ellipsis included — a caller sizing a row
  // can trust the number without re-measuring.
  it("caps a pasted paragraph at the name budget, ellipsis inside it", () => {
    const name = layerDisplayName(textLayer("x".repeat(500)), tEn);
    expect(name).toHaveLength(TEXT_NAME_MAX);
    expect(name.endsWith("...")).toBe(true);
    // Exactly at the budget nothing is spent on dots.
    const exact = layerDisplayName(textLayer("y".repeat(TEXT_NAME_MAX)), tEn);
    expect(exact).toBe("y".repeat(TEXT_NAME_MAX));
  });

  // Blank content is absent, exactly as a blank label is: a zero-width name is
  // strictly worse than the kind word it displaced, and the panels that filter
  // empty names out would render a row with no name at all.
  it("falls through to the translated kind when the text is blank", () => {
    for (const blank of ["", "   ", "\n\t "]) {
      expect(layerDisplayName(textLayer(blank), tEn)).toBe("Text");
      expect(layerDisplayName(textLayer(blank), tZh)).toBe("文本");
    }
  });

  // The Group rung is the media rung for a kind whose source is a composition:
  // without it every Group clip in the project reads "Group".
  it("names a Group layer after the composition it shows", () => {
    const ordinals = new Map([["g-a", 1]]);
    expect(layerDisplayName(groupLayer("g-a", null), tEn, ordinals)).toBe(
      "Group 1",
    );
    expect(layerDisplayName(groupLayer("g-a", "Intro build"), tEn, ordinals)).toBe(
      "Intro build",
    );
    // The layer's own label still outranks the composition's, exactly as it
    // outranks a video clip's file name.
    expect(
      layerDisplayName(groupLayer("g-a", "Intro build", "Take 2"), tEn, ordinals),
    ).toBe("Take 2");
  });

  it("never returns the uuid", () => {
    const nameless = videoLayer("");
    expect(layerDisplayName(nameless, tEn)).toBe("Video");
    expect(layerDisplayName(nameless, tEn)).not.toContain(nameless.id);
  });
});
