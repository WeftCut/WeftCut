// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { formatCommandError } from "./formatCommandError";
import i18n from "../i18n";
import { useProjectStore } from "../state/projectStore";
import type { CommandError } from "../../shared/commandErrors";
import type { CompositionSummary, ProjectSummary } from "../ipc";
import { summaryFixture } from "../testing/summaryFixture";

/// Minimal mirror snapshot: two named clips on a labelled track, one track
/// with no label (positional fallback), 30 fps composition.
function seedStore(): void {
  const layer = (id: string, label: string | null, mediaLabel?: string) => ({
    id,
    label,
    t_start_us: 0,
    t_end_us: 2_000_000,
    kind: "Video",
    color_hint: "",
    enabled: true,
    locked: false,
    params: mediaLabel
      ? { kind: "VideoClip", media_id: "m-1", media_label: mediaLabel }
      : { kind: "Color" },
    effects: [],
  });
  const summary = summaryFixture({
    project_id: "p-1",
    name: "Test",
    media: [{ id: "m-1", label: "Aurora.mp4" }] as unknown as ProjectSummary["media"],
    root: {
      duration_us: 2_000_000,
      tracks: [
      {
        id: "t-1",
        kind: "Video",
        label: "B-Roll",
        enabled: true,
        locked: false,
        muted: false,
        solo: false,
        role: null,
        transient: false,
        layers: [layer("l-a", "Interview A"), layer("l-b", null, "Ember.mp4")],
      },
      {
        id: "t-2",
        kind: "Video",
        label: null,
        enabled: true,
        locked: true,
        muted: false,
        solo: false,
        role: null,
        transient: false,
        layers: [],
      },
    ] as unknown as CompositionSummary["tracks"],
    },
  });
  useProjectStore.getState().apply(summary);
}

afterEach(() => {
  useProjectStore.getState().apply(null);
});

describe("formatCommandError — curated tier", () => {
  it("LayerOverlap names both clips and the track", () => {
    seedStore();
    const out = formatCommandError({
      error: "ValidationFailed",
      detail: {
        rule: "LayerOverlap",
        track: "t-1",
        a: "l-a",
        a_start: 0,
        a_end: 2_000_000,
        b: "l-b",
        b_start: 1_000_000,
        b_end: 3_000_000,
      },
    });
    expect(out.level).toBe("error");
    expect(out.message).toBe(
      "Can't place “Ember.mp4” there — it would overlap “Interview A” on B-Roll.",
    );
    expect(out.i18n_key).toBe("errors.layer_overlap");
    expect(out.i18n_args).toMatchObject({
      incoming: "Ember.mp4",
      blocking: "Interview A",
      track: "B-Roll",
    });
  });

  // The refusal has to name the lane the way its header does, or the user is
  // sent looking for a row that reads differently.
  it("an unlabelled, role-less track falls back to its positional name", () => {
    seedStore();
    const out = formatCommandError({ error: "TrackLocked", track: "t-2" });
    expect(out.message).toBe("Track 2 is locked.");
  });

  it("ids the mirror can't resolve degrade to short ids, never raw uuids", () => {
    seedStore();
    const out = formatCommandError({
      error: "TrackLocked",
      track: "99999999-aaaa-4bbb-8ccc-000000000000",
    });
    expect(out.message).toBe("#99999999 is locked.");
  });

  it("SplitOutsideLayer renders the position as composition timecode", () => {
    seedStore();
    const out = formatCommandError({
      error: "SplitOutsideLayer",
      layer: "l-a",
      at_t: 1_500_000,
    });
    expect(out.message).toContain("Interview A");
    // 1.5 s at 30 fps → second 1, frame 15.
    expect(out.message).toMatch(/01[:.]15/);
  });

  it("TransitionInsufficientHandle renders available_us as seconds", () => {
    seedStore();
    const out = formatCommandError({
      error: "TransitionInsufficientHandle",
      layer: "l-a",
      available_us: 433_333,
    });
    expect(out.message).toContain("0.43s");
  });

  it("FpsLockedByContent picks the history phrasing via i18next context", () => {
    seedStore();
    const current = { num: 30, den: 1 };
    const requested = { num: 60, den: 1 };
    const live = formatCommandError({
      error: "FpsLockedByContent",
      current,
      requested,
      layer_count: 3,
      locked_by: "current",
    });
    expect(live.message).toContain("still holds 3 clip(s)");
    const history = formatCommandError({
      error: "FpsLockedByContent",
      current,
      requested,
      layer_count: 0,
      locked_by: "history",
    });
    expect(history.message).toContain("undo history");
    expect(history.i18n_args).toMatchObject({ context: "history" });
  });
});

describe("formatCommandError — generic and suppressed tiers", () => {
  it("suppressed no-ops land at debug", () => {
    expect(formatCommandError({ error: "NothingToUndo" })).toEqual({
      level: "debug",
      message: "Nothing to undo",
    });
  });

  it("generic variants humanize the code and list fields", () => {
    const out = formatCommandError({
      error: "TrackPositionOutOfRange",
      position: 9,
      len: 4,
    });
    expect(out.level).toBe("error");
    expect(out.message).toBe("Track position out of range (position 9, len 4)");
    expect(out.i18n_key).toBeUndefined();
  });

  it("generic prose fields pass through whole; uuids shorten", () => {
    const prose = formatCommandError({
      error: "HistoryLocked",
      reason: "an export is writing checkpoints right now",
    });
    expect(prose.message).toContain(
      "an export is writing checkpoints right now",
    );
    const uuid = formatCommandError({
      error: "LayerNotFound",
      layer: "3f9c12ab-0000-4000-8000-000000000001",
    });
    expect(uuid.message).toBe("Layer not found (layer #3f9c12ab)");
  });

  it("non-curated validation rules compose under a Validation failed prefix", () => {
    const out = formatCommandError({
      error: "ValidationFailed",
      detail: {
        rule: "InvalidSrcRange",
        layer: "l-x",
        src_in: 5,
        src_out: 3,
      },
    });
    expect(out.message).toBe(
      "Validation failed: Invalid src range (layer l-x, src_in 5, src_out 3)",
    );
  });
});

// The whole refusal set of the cross-composition move, in one place. Nothing in
// the editor calls it yet, so only the two lane refusals a drop can hit are
// curated and the rest stay plumbing — what this pins is that every one of them
// still produces a line, and that a curated key resolves in BOTH locales rather
// than reaching the panel as its own raw key.
describe("formatCommandError — the cross-composition move's refusals", () => {
  const REFUSALS: CommandError[] = [
    { error: "InvalidArgument", field: "to_composition", detail: "the set is already in composition c-1" },
    { error: "InvalidArgument", field: "anchor_layer_id", detail: "layer l-x is not in the moving set" },
    { error: "InvalidArgument", field: "layer_ids", detail: "layer l-a would land at -500000 µs" },
    { error: "LayerNotFound", layer: "l-x" },
    { error: "CrossCompositionSet", layer: "l-a", composition: "c-1", expected: "c-2" },
    { error: "CompositionNotFound", composition: "c-1" },
    { error: "TrackNotFound", track: "t-9" },
    { error: "TrackLocked", track: "t-2" },
    { error: "GroupLockedMember", layer: "l-a" },
    { error: "ValidationFailed", detail: { rule: "CompositionCycle", path: ["c-1", "c-1"] } },
    {
      error: "ValidationFailed",
      detail: {
        rule: "LayerOverlap", track: "t-1",
        a: "l-a", a_start: 0, a_end: 2_000_000,
        b: "l-b", b_start: 0, b_end: 1_000_000,
      },
    },
  ];

  it("renders every one of them, and each curated key resolves in both locales", () => {
    seedStore();
    for (const err of REFUSALS) {
      const where = JSON.stringify(err);
      const out = formatCommandError(err);
      expect(out.level, where).toBe("error");
      expect(out.message.length, where).toBeGreaterThan(0);
      if (!out.i18n_key) continue;
      for (const lng of ["en-US", "zh-CN"]) {
        const t = i18n.getFixedT(lng);
        expect(t(out.i18n_key, out.i18n_args ?? {}), `${lng} ${out.i18n_key}`).not.toBe(out.i18n_key);
      }
    }
  });
});
