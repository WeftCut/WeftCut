import { describe, expect, it } from "vitest";
import { FoldVertical, UnfoldVertical } from "lucide-react";

import {
  buildAppCommands,
  nextPlaybackResolution,
  PLAYBACK_RESOLUTION_CYCLE,
} from "../commands/appCommands";
import type { AppSettings } from "../ipc";
import { ACTION_DEFS, type ActionId } from "../shortcuts/defs";
import type { HandlerMap } from "../shortcuts/useShortcuts";
import {
  QUICK_ACTION_IDS,
  QUICK_ACTION_SECTIONS,
  resolveIcon,
  type QuickActionItem,
  type QuickActionState,
} from "./quickActions";

/// Every catalogued action wired, so the factory emits the full command set.
function allHandlers(): HandlerMap {
  const handlers: HandlerMap = {};
  for (const id of Object.keys(ACTION_DEFS) as ActionId[]) {
    handlers[id] = () => {};
  }
  return handlers;
}

function commandIds(): Set<string> {
  const defs = buildAppCommands(
    allHandlers(),
    {
      addColorLayer: () => {},
      addTextLayer: () => {},
      openMotifPicker: () => {},
      openAgentPanel: () => {},
      enterAgentMode: () => {},
      createCheckpoint: () => {},
      moveToNewTrack: () => {},
      toggleMarkersVisible: () => {},
      applyDefaultTransition: () => {},
    },
    { busy: false, canUndo: false, canRedo: false, canBlade: false, exportLocked: false },
  );
  return new Set(defs.map((d) => d.id));
}

/// Build a state, naming only the fields a case actually exercises — so adding
/// a field to `QuickActionState` doesn't rewrite every literal in this file.
function state(over: Partial<QuickActionState> = {}): QuickActionState {
  return {
    tool: "select",
    displayMode: "AbRoll",
    hasRange: false,
    markersVisible: true,
    snapEnabled: true,
    followPlayhead: true,
    safeAreaGuides: false,
    playbackResolution: "full",
    canGroup: false,
    canDissolve: false,
    ...over,
  };
}

describe("quickActions catalogue", () => {
  // The strip resolves `run` / `enabled` / `labelKey` by id at render time, so
  // a typo or a renamed action would silently drop a button instead of failing
  // to compile. This is that gate.
  it("every strip id resolves to a real command", () => {
    const available = commandIds();
    for (const id of QUICK_ACTION_IDS) {
      expect(available, `no command registered for "${id}"`).toContain(id);
    }
  });

  it("has no duplicate ids across sections", () => {
    expect(new Set(QUICK_ACTION_IDS).size).toBe(QUICK_ACTION_IDS.length);
  });

  // Both halves matter: the static fallback, and what actually reaches the
  // button once a state-bearing `iconFor` has had its say.
  it("gives every item an icon in every state", () => {
    for (const section of QUICK_ACTION_SECTIONS) {
      for (const item of section.items) {
        expect(item.icon, `"${item.id}" has no icon`).toBeTruthy();
        for (const displayMode of ["AbRoll", "AllTracks"] as const) {
          expect(
            resolveIcon(item, state({ displayMode })),
            `"${item.id}" resolves no icon @ ${displayMode}`,
          ).toBeTruthy();
        }
        for (const playbackResolution of PLAYBACK_RESOLUTION_CYCLE) {
          expect(
            resolveIcon(item, state({ playbackResolution })),
            `"${item.id}" resolves no icon @ ${playbackResolution}`,
          ).toBeTruthy();
        }
      }
    }
  });

  // A radio section models a modal choice, so exactly one member must read as
  // armed for any reachable state — otherwise the strip shows either no
  // current tool or two at once.
  it("radio sections arm exactly one item per state", () => {
    // Every modal axis crossed with itself. The tool is the only one left:
    // the playback resolution dropped out of this case when its three
    // buttons became one cycling button, which is `command` and arms
    // nothing (see the cycler's own cases below). A tool the section forgot
    // would leave the whole radiogroup unarmed for that value — the failure
    // this case exists for.
    const states: QuickActionState[] = [
      state({ tool: "select", displayMode: "AbRoll" }),
      state({ tool: "select", displayMode: "AllTracks" }),
      state({ tool: "blade", displayMode: "AbRoll" }),
      state({ tool: "blade", displayMode: "AllTracks" }),
    ];
    for (const section of QUICK_ACTION_SECTIONS) {
      if (section.mode !== "radio") continue;
      for (const s of states) {
        const armed = section.items.filter((item) => item.active?.(s) === true);
        expect(armed, `section "${section.id}" @ tool=${s.tool}`).toHaveLength(1);
      }
    }
  });

  // The mode is what the panel turns into `aria-checked` / `aria-pressed` /
  // nothing, so `active` has to be present exactly where a pressed state is
  // claimed. A stateful section missing it would render permanently unpressed;
  // a `command` item carrying it would announce a switch that doesn't exist.
  it("declares a pressed state on exactly the stateful sections", () => {
    for (const section of QUICK_ACTION_SECTIONS) {
      for (const item of section.items) {
        if (section.mode === "command") {
          expect(item.active, `"${item.id}" is momentary but declares active`)
            .toBeUndefined();
        } else {
          expect(item.active, `"${item.id}" declares no active`).toBeTypeOf(
            "function",
          );
        }
      }
    }
  });

  // The glyph is the at-a-glance read of the display mode; the pressed border
  // alone can't say WHICH way the rows are folded. It depicts the current
  // state (not the click's effect) so it agrees with `aria-pressed`.
  it("folds and unfolds the display-toggle glyph with the mode", () => {
    const item: QuickActionItem | undefined = QUICK_ACTION_SECTIONS.flatMap(
      (s) => s.items,
    ).find((i) => i.id === "toggleDisplayMode");
    if (!item) throw new Error("no strip item for toggleDisplayMode");
    expect(resolveIcon(item, state({ displayMode: "AbRoll" }))).toBe(FoldVertical);
    expect(resolveIcon(item, state({ displayMode: "AllTracks" }))).toBe(
      UnfoldVertical,
    );
  });

  it("tracks the display mode with the retired pill's own hint wording", () => {
    const item = QUICK_ACTION_SECTIONS.flatMap((s) => s.items).find(
      (i) => i.id === "toggleDisplayMode",
    );
    expect(item?.hint?.(state({ displayMode: "AbRoll" }))).toBe(
      "timeline.mode_ab_roll_hint",
    );
    expect(item?.hint?.(state({ displayMode: "AllTracks" }))).toBe(
      "timeline.mode_all_tracks_hint",
    );
    expect(item?.active?.(state({ displayMode: "AbRoll" }))).toBe(true);
    expect(item?.active?.(state({ displayMode: "AllTracks" }))).toBe(false);
  });

  // An independent toggle whose state is carried by the pressed attributes and
  // the hint alone: one fixed bookmark glyph, no `iconFor`.
  describe("marker visibility toggle", () => {
    const item = (): QuickActionItem => {
      const found = QUICK_ACTION_SECTIONS.flatMap((s) => s.items).find(
        (i) => i.id === "toggleMarkersVisible",
      );
      if (!found) throw new Error("no strip item for toggleMarkersVisible");
      return found;
    };

    it("sits in the independent-toggles section, not with the momentary commands", () => {
      const section = QUICK_ACTION_SECTIONS.find((s) =>
        s.items.some((i) => i.id === "toggleMarkersVisible"),
      );
      expect(section?.id).toBe("toggles");
      expect(section?.mode).toBe("independent");
    });

    it("reads as pressed while markers are showing", () => {
      expect(item().active?.(state({ markersVisible: true }))).toBe(true);
      expect(item().active?.(state({ markersVisible: false }))).toBe(false);
    });

    // Both halves of the tooltip's job: state the current state, and say what a
    // click will do. Two states, two distinct keys — a single key could not.
    it("returns a distinct hint for each state", () => {
      const showing = item().hint?.(state({ markersVisible: true }));
      const hidden = item().hint?.(state({ markersVisible: false }));
      expect(showing).toBe("quick_actions.markers_shown_hint");
      expect(hidden).toBe("quick_actions.markers_hidden_hint");
      expect(showing).not.toBe(hidden);
    });

    // State is already carried by the pressed styling and `aria-pressed`, so a
    // crossed-out glyph variant would restate at 16 px what the button already
    // says (spec decision 13). One glyph, both ways.
    it("keeps one fixed glyph in both states", () => {
      expect(item().iconFor).toBeUndefined();
      expect(resolveIcon(item(), state({ markersVisible: true }))).toBe(
        resolveIcon(item(), state({ markersVisible: false })),
      );
    });
  });

  // The Clear button spends most of its life disabled; the hint is the only
  // thing that explains why, so it must actually change with the range.
  it("explains why Clear is unavailable when no range is marked", () => {
    const item = QUICK_ACTION_SECTIONS.flatMap((s) => s.items).find(
      (i) => i.id === "clearRange",
    );
    expect(item?.hint?.(state({ hasRange: false }))).toBe(
      "quick_actions.clear_range_empty",
    );
    expect(item?.hint?.(state({ hasRange: true }))).toBe("actions.clear_range");
  });

  // The three settings toggles that joined the strip. Each has to say which
  // state it is IN and what a click would do — one key could not carry both,
  // which is why the assertion is that the two differ.
  describe("settings toggles", () => {
    const item = (id: string): QuickActionItem => {
      const found = QUICK_ACTION_SECTIONS.flatMap((s) => s.items).find(
        (i) => i.id === id,
      );
      if (!found) throw new Error(`no strip item for ${id}`);
      return found;
    };

    it.each([
      ["toggleTailSnap", "snapEnabled"],
      ["toggleFollowPlayhead", "followPlayhead"],
      ["toggleSafeAreaGuides", "safeAreaGuides"],
    ] as const)("tracks %s with its setting", (id, field) => {
      expect(item(id).active?.(state({ [field]: true }))).toBe(true);
      expect(item(id).active?.(state({ [field]: false }))).toBe(false);
      const on = item(id).hint?.(state({ [field]: true }));
      const off = item(id).hint?.(state({ [field]: false }));
      expect(on).toBeTypeOf("string");
      expect(on).not.toBe(off);
    });

    // All three sit with the independent toggles, not the momentary commands:
    // each answers only for itself, so `aria-pressed` is the honest attribute.
    it.each([
      "toggleTailSnap",
      "toggleFollowPlayhead",
      "toggleSafeAreaGuides",
    ])("puts %s in the independent-toggles section", (id) => {
      const section = QUICK_ACTION_SECTIONS.find((s) =>
        s.items.some((i) => i.id === id),
      );
      expect(section?.id).toBe("toggles");
      expect(section?.mode).toBe("independent");
    });
  });

  // Same disabled-button rule as Clear range, for the pair whose precondition
  // is a SELECTION rather than project content.
  it("explains why the group buttons are unavailable", () => {
    const item = (id: string) =>
      QUICK_ACTION_SECTIONS.flatMap((s) => s.items).find((i) => i.id === id);
    expect(item("groupSelected")?.hint?.(state({ canGroup: false }))).toBe(
      "quick_actions.group_needs_two",
    );
    expect(item("groupSelected")?.hint?.(state({ canGroup: true }))).toBe(
      "actions.group_selected",
    );
    expect(
      item("dissolveSelectedGroup")?.hint?.(state({ canDissolve: false })),
    ).toBe("quick_actions.dissolve_no_group");
    expect(
      item("dissolveSelectedGroup")?.hint?.(state({ canDissolve: true })),
    ).toBe("actions.dissolve_selected_group");
  });

  // The strip could hide markers it had no way to create until this row
  // existed. Add and show are the same feature but not the same kind of
  // control, and the ARIA mode is what keeps them in different sections.
  it("separates marker authoring from marker visibility", () => {
    const sectionOf = (id: string) =>
      QUICK_ACTION_SECTIONS.find((s) => s.items.some((i) => i.id === id));
    expect(sectionOf("addMarkerAtPlayhead")?.mode).toBe("command");
    expect(sectionOf("toggleMarkersVisible")?.mode).toBe("independent");
    expect(sectionOf("addMarkerAtPlayhead")?.id).not.toBe(
      sectionOf("toggleMarkersVisible")?.id,
    );
  });

  // The section that used to spend three slots stating one value. Everything
  // below is what makes ONE button honest in their place: a glyph per rung, a
  // hint per rung, and a walk that reaches every rung and comes back.
  describe("playback resolution cycler", () => {
    const item = (): QuickActionItem => {
      const found = QUICK_ACTION_SECTIONS.flatMap((s) => s.items).find(
        (i) => i.id === "cyclePlaybackResolution",
      );
      if (!found) throw new Error("no strip item for cyclePlaybackResolution");
      return found;
    };

    // `radio` would need siblings to be exclusive WITH, and `independent`
    // would hang `aria-pressed` on a control that has no off state. A
    // one-button three-state control is momentary or it is lying.
    it("is a momentary command, alone in its section", () => {
      const section = QUICK_ACTION_SECTIONS.find((s) =>
        s.items.some((i) => i.id === "cyclePlaybackResolution"),
      );
      expect(section?.id).toBe("resolution");
      expect(section?.mode).toBe("command");
      expect(section?.items).toHaveLength(1);
      expect(item().active).toBeUndefined();
    });

    // With no pressed border and no radio state, the glyph is the ONLY thing
    // reporting the current value — so two rungs sharing a glyph would be
    // indistinguishable on screen, not merely repetitive.
    it("draws a distinct glyph for every rung", () => {
      const glyphs = PLAYBACK_RESOLUTION_CYCLE.map((playbackResolution) =>
        resolveIcon(item(), state({ playbackResolution })),
      );
      for (const glyph of glyphs) expect(glyph).toBeTruthy();
      expect(new Set(glyphs).size).toBe(PLAYBACK_RESOLUTION_CYCLE.length);
    });

    // Same argument for the hint, which is also the `aria-label`: with no ARIA
    // state attribute on the button, it is the whole of what a screen reader
    // gets.
    it("carries a distinct hint for every rung", () => {
      const hints = PLAYBACK_RESOLUTION_CYCLE.map((playbackResolution) =>
        item().hint?.(state({ playbackResolution })),
      );
      for (const hint of hints) expect(hint).toBeTypeOf("string");
      expect(new Set(hints).size).toBe(PLAYBACK_RESOLUTION_CYCLE.length);
    });

    // A walk that skipped a rung would strand a resolution nothing on the
    // strip could reach; one that failed to wrap would be a one-way trip to
    // quarter, with Settings the only way back.
    it("reaches every rung and returns to the start", () => {
      const walked: AppSettings["playback_resolution"][] = [];
      let at = PLAYBACK_RESOLUTION_CYCLE[0]!;
      for (let step = 0; step < PLAYBACK_RESOLUTION_CYCLE.length; step += 1) {
        walked.push(at);
        at = nextPlaybackResolution(at);
      }
      expect(walked).toEqual([...PLAYBACK_RESOLUTION_CYCLE]);
      expect(new Set(walked).size).toBe(PLAYBACK_RESOLUTION_CYCLE.length);
      expect(at).toBe(PLAYBACK_RESOLUTION_CYCLE[0]);
    });

    // Descending, because the button is reached FOR shedding resolution when
    // playback stutters. That is the reverse of the Settings slider's
    // `RESOLUTION_STOPS`, whose right-hand end has to be the better picture.
    it("walks down the quality ladder", () => {
      expect([...PLAYBACK_RESOLUTION_CYCLE]).toEqual(["full", "half", "quarter"]);
    });

    // A settings file predating the field, or a hand edit, is not on the
    // ladder and so has no successor. The walk resumes at the top — the same
    // direction `playbackScaleDiv` defaults an unknown value.
    it("resumes at the top from a value that is not on the ladder", () => {
      expect(
        nextPlaybackResolution("eighth" as AppSettings["playback_resolution"]),
      ).toBe("full");
    });
  });

  // Gating this one would mean subscribing the strip to the PLAYHEAD — a
  // re-render per frame, which the playhead gate forbids. The command no-ops
  // over a gap instead, so the button must not claim a hint that promises a
  // disabled state it will never render.
  it("leaves the playhead split ungated and unhinted", () => {
    const item = QUICK_ACTION_SECTIONS.flatMap((s) => s.items).find(
      (i) => i.id === "splitAtPlayhead",
    );
    expect(item).toBeDefined();
    expect(item?.hint).toBeUndefined();
  });
});
