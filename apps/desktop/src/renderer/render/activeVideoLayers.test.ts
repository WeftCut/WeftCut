import { describe, it, expect } from "vitest";
import {
  selectActiveVideoLayers,
  referencedVideoMediaIds,
  hasVisibleContent,
} from "./activeVideoLayers";
import { exportHandleKey } from "./decoder/ExportDecoderPool";
import type { ProjectSummary } from "../ipc";

const layer = (over: Record<string, unknown>) => ({
  id: "L", label: null, t_start_us: 0, t_end_us: 1_000_000, kind: "VideoClip",
  color_hint: "#000", enabled: true, locked: false, effects: [],
  params: { kind: "VideoClip", media_id: "vid", media_label: "", src_in_us: 0, src_out_us: 1_000_000,
    x: 0, y: 0, scale_x: 1, scale_y: 1, opacity: 1, speed: 1, flip_h: false, flip_v: false,
    fade_in_us: 0, fade_out_us: 0 },
  ...over,
});
/// A Group layer: `t_start_us`/`t_end_us` place it on its parent's timeline,
/// `src_in_us` says where in the referenced composition its window opens.
const ref = (over: Record<string, unknown> & { params: Record<string, unknown> }) => ({
  id: "G", label: null, t_start_us: 0, t_end_us: 1_000_000, kind: "CompositionRef",
  color_hint: "#000", enabled: true, locked: false, effects: [],
  ...over,
  params: { kind: "CompositionRef", composition_label: null, src_in_us: 0, ...over.params },
});
/// The tracks land on the ROOT — the composition export walks. `groups` are the
/// further compositions Group layers point at, keyed by id.
const summaryOf = (
  tracks: unknown[],
  groups: Record<string, unknown[]> = {},
): ProjectSummary =>
  ({
    root_id: "root",
    compositions: {
      root: { tracks },
      ...Object.fromEntries(
        Object.entries(groups).map(([id, ts]) => [id, { tracks: ts }]),
      ),
    },
  } as unknown as ProjectSummary);

describe("selectActiveVideoLayers", () => {
  it("selects enabled VideoClip layers on enabled tracks overlapping [aUs, bUs]", () => {
    const s = summaryOf([
      { enabled: true, layers: [layer({ id: "A", params: { kind: "VideoClip", media_id: "a", src_in_us: 0 } })] },
    ]);
    expect(selectActiveVideoLayers(s, 0, 999_999).map((l) => l.layerId)).toEqual(["A"]);
  });

  it("skips disabled tracks, disabled layers, and non-VideoClip layers", () => {
    const s = summaryOf([
      { enabled: false, layers: [layer({ id: "offtrack" })] },
      { enabled: true, layers: [layer({ id: "offlayer", enabled: false })] },
      { enabled: true, layers: [layer({ id: "audio", params: { kind: "Audio", media_id: "x" } })] },
      { enabled: true, layers: [layer({ id: "keep", params: { kind: "VideoClip", media_id: "k", src_in_us: 0 } })] },
    ]);
    expect(selectActiveVideoLayers(s, 0, 999_999).map((l) => l.layerId)).toEqual(["keep"]);
  });

  it("excludes layers outside [aUs, bUs] (bUs inclusive)", () => {
    const s = summaryOf([
      { enabled: true, layers: [
        layer({ id: "before", t_start_us: 0, t_end_us: 100 }),   // ends at 100 → excluded when aUs=100
        layer({ id: "after", t_start_us: 200, t_end_us: 300 }),  // starts at 200 → excluded when bUs=199
      ] },
    ]);
    expect(selectActiveVideoLayers(s, 100, 199).map((l) => l.layerId)).toEqual([]);
  });

  it("decodes a clip inside a Group at its MAPPED root time, keyed per placement", () => {
    // The Group sits at 2 s reading its composition from 0.5 s in, so that
    // composition's own 0 is at root 1.5 s and its 1 s–2 s clip is live over
    // root 2.5 s–3.5 s. The Worker's per-frame `tStartUs <= tUs < tEndUs` and
    // its `srcInUs + (tUs - tStartUs)` PTS math both read these numbers, so
    // they have to be root-time or the export decodes the wrong frames.
    const s = summaryOf(
      [{ enabled: true, layers: [ref({ t_start_us: 2_000_000, t_end_us: 4_000_000, params: { composition_id: "g", src_in_us: 500_000 } })] }],
      { g: [{ enabled: true, layers: [layer({ id: "inner", t_start_us: 1_000_000, t_end_us: 2_000_000, params: { kind: "VideoClip", media_id: "m", src_in_us: 300_000 } })] }] },
    );
    expect(selectActiveVideoLayers(s, 0, 9_999_999)).toEqual([
      {
        layerId: "G/inner",
        mediaId: "m",
        tStartUs: 2_500_000,
        tEndUs: 3_500_000,
        srcInUs: 300_000,
      },
    ]);
  });

  it("turns what a Group's window clipped into a source trim", () => {
    // The Group shows only its first second, so the clip's tail is cut: the
    // placement ends at the window and `srcInUs` stays put (nothing was cut
    // off the head).
    const s = summaryOf(
      [{ enabled: true, layers: [ref({ t_start_us: 0, t_end_us: 1_000_000, params: { composition_id: "g" } })] }],
      { g: [{ enabled: true, layers: [layer({ id: "inner", t_start_us: 0, t_end_us: 5_000_000, params: { kind: "VideoClip", media_id: "m", src_in_us: 0 } })] }] },
    );
    expect(selectActiveVideoLayers(s, 0, 9_999_999)).toEqual([
      { layerId: "G/inner", mediaId: "m", tStartUs: 0, tEndUs: 1_000_000, srcInUs: 0 },
    ]);

    // Reading the same composition from 2 s in cuts the HEAD instead, and the
    // source-in advances by exactly what was cut.
    const trimmed = summaryOf(
      [{ enabled: true, layers: [ref({ t_start_us: 0, t_end_us: 1_000_000, params: { composition_id: "g", src_in_us: 2_000_000 } })] }],
      { g: [{ enabled: true, layers: [layer({ id: "inner", t_start_us: 0, t_end_us: 5_000_000, params: { kind: "VideoClip", media_id: "m", src_in_us: 0 } })] }] },
    );
    expect(selectActiveVideoLayers(trimmed, 0, 9_999_999)).toEqual([
      { layerId: "G/inner", mediaId: "m", tStartUs: 0, tEndUs: 1_000_000, srcInUs: 2_000_000 },
    ]);
  });

  it("gives two placements of one Group two decode pipelines", () => {
    // At any one output time the two instances want different source frames of
    // the same media, which is precisely the phase difference `exportHandleKey`
    // separates — serving both from one ring is the same-source overlap wedge.
    const s = summaryOf(
      [{ enabled: true, layers: [
        ref({ id: "A", t_start_us: 0, t_end_us: 1_000_000, params: { composition_id: "g" } }),
        ref({ id: "B", t_start_us: 4_000_000, t_end_us: 5_000_000, params: { composition_id: "g" } }),
      ] }],
      { g: [{ enabled: true, layers: [layer({ id: "inner", t_start_us: 0, t_end_us: 1_000_000, params: { kind: "VideoClip", media_id: "m", src_in_us: 0 } })] }] },
    );
    const selected = selectActiveVideoLayers(s, 0, 9_999_999);
    expect(selected.map((l) => l.layerId)).toEqual(["A/inner", "B/inner"]);
    const keys = selected.map((l) => exportHandleKey(l.mediaId, l.srcInUs, l.tStartUs));
    expect(new Set(keys).size).toBe(2);
  });

  it("skips a Group the summary cannot resolve, and a disabled one", () => {
    const s = summaryOf(
      [
        { enabled: true, layers: [ref({ id: "ghost", params: { composition_id: "missing" } })] },
        { enabled: true, layers: [ref({ id: "off", enabled: false, params: { composition_id: "g" } })] },
      ],
      { g: [{ enabled: true, layers: [layer({ id: "inner", params: { kind: "VideoClip", media_id: "m", src_in_us: 0 } })] }] },
    );
    expect(selectActiveVideoLayers(s, 0, 9_999_999)).toEqual([]);
  });
});

describe("referencedVideoMediaIds", () => {
  it("returns distinct media ids for layers overlapping [startUs, endUs)", () => {
    const s = summaryOf([
      { enabled: true, layers: [
        layer({ id: "A", t_start_us: 0, t_end_us: 500, params: { kind: "VideoClip", media_id: "a", src_in_us: 0 } }),
        layer({ id: "B", t_start_us: 500, t_end_us: 1000, params: { kind: "VideoClip", media_id: "a", src_in_us: 0 } }),
        layer({ id: "C", t_start_us: 2000, t_end_us: 3000, params: { kind: "VideoClip", media_id: "c", src_in_us: 0 } }),
      ] },
    ]);
    // Range [0, 1000): A and B (both media "a"); C excluded.
    expect([...referencedVideoMediaIds(s, 0, 1000)].sort()).toEqual(["a"]);
  });

  it("includes media only a Group references — the readiness gate must see it", () => {
    const s = summaryOf(
      [{ enabled: true, layers: [ref({ params: { composition_id: "g" } })] }],
      { g: [{ enabled: true, layers: [layer({ id: "inner", params: { kind: "VideoClip", media_id: "nested", src_in_us: 0 } })] }] },
    );
    expect([...referencedVideoMediaIds(s, 0, 1_000_000)]).toEqual(["nested"]);
  });
});

describe("hasVisibleContent", () => {
  it("is true when any enabled non-Audio layer overlaps the range", () => {
    for (const kind of ["VideoClip", "ImageOverlay", "Text", "Color", "Motif"]) {
      const s = summaryOf([
        { enabled: true, layers: [layer({ params: { kind } })] },
      ]);
      expect(hasVisibleContent(s, 0, 1_000_000)).toBe(true);
    }
  });

  it("is false for an audio-only project (only Audio layers)", () => {
    const s = summaryOf([
      { enabled: true, layers: [layer({ params: { kind: "Audio", media_id: "a" } })] },
    ]);
    expect(hasVisibleContent(s, 0, 1_000_000)).toBe(false);
  });

  it("ignores disabled tracks, disabled layers, and out-of-range layers", () => {
    const s = summaryOf([
      { enabled: false, layers: [layer({ params: { kind: "Color" } })] },
      { enabled: true, layers: [layer({ enabled: false, params: { kind: "Color" } })] },
      { enabled: true, layers: [layer({ t_start_us: 5_000_000, t_end_us: 6_000_000, params: { kind: "Color" } })] },
    ]);
    expect(hasVisibleContent(s, 0, 1_000_000)).toBe(false);
  });

  it("uses half-open overlap with [startUs, endUs)", () => {
    const s = summaryOf([
      { enabled: true, layers: [layer({ t_start_us: 1_000_000, t_end_us: 2_000_000, params: { kind: "Color" } })] },
    ]);
    expect(hasVisibleContent(s, 0, 1_000_000)).toBe(false); // ends exactly at start of nothing; layer starts at endUs
    expect(hasVisibleContent(s, 0, 1_000_001)).toBe(true);
  });

  it("sees content inside a Group, and none in an empty one", () => {
    // A Group layer is not itself content: the answer is whatever is inside it,
    // so a Group over an empty composition is still "no video material".
    const filled = summaryOf(
      [{ enabled: true, layers: [ref({ params: { composition_id: "g" } })] }],
      { g: [{ enabled: true, layers: [layer({ id: "inner", params: { kind: "Color" } })] }] },
    );
    expect(hasVisibleContent(filled, 0, 1_000_000)).toBe(true);

    const empty = summaryOf(
      [{ enabled: true, layers: [ref({ params: { composition_id: "g" } })] }],
      { g: [] },
    );
    expect(hasVisibleContent(empty, 0, 1_000_000)).toBe(false);

    const audioOnly = summaryOf(
      [{ enabled: true, layers: [ref({ params: { composition_id: "g" } })] }],
      { g: [{ enabled: true, layers: [layer({ id: "inner", params: { kind: "Audio", media_id: "a" } })] }] },
    );
    expect(hasVisibleContent(audioOnly, 0, 1_000_000)).toBe(false);
  });

  it("is false when the Group's window leaves nothing of its content in range", () => {
    // The Group shows [0, 1 s) of a composition whose only layer starts at 2 s.
    const s = summaryOf(
      [{ enabled: true, layers: [ref({ t_start_us: 0, t_end_us: 1_000_000, params: { composition_id: "g" } })] }],
      { g: [{ enabled: true, layers: [layer({ id: "inner", t_start_us: 2_000_000, t_end_us: 3_000_000, params: { kind: "Color" } })] }] },
    );
    expect(hasVisibleContent(s, 0, 1_000_000)).toBe(false);
  });
});
