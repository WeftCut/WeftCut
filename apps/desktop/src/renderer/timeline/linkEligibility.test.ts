import { afterEach, describe, expect, it } from "vitest";

import {
  canToggleLinkSelection,
  enclosingLink,
  linkFanoutActive,
  linkToggleForSelection,
} from "./linkEligibility";
import type { LinkSummary, ProjectSummary } from "../ipc";
import { setLinkOverride } from "../state/linkOverrideStore";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";

/// Only the two fields the predicates read carry any content — everything else
/// is the shape `ProjectSummary` demands.
function seed(links: LinkSummary[]): void {
  const summary: ProjectSummary = {
    project_id: "p",
    name: "p",
    composition: {
      width: 640,
      height: 360,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
    },
    track_count: 0,
    layer_count: 0,
    duration_us: 0,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    tracks: [],
    markers: [],
    transitions: [],
    links,
    audio_roles: [],
  };
  useProjectStore.getState().apply(summary);
}

afterEach(() => {
  clearLayerSelection();
  useProjectStore.getState().apply(null);
  setLinkOverride(false);
});

// The one predicate every fan-out site reads. Two escapes, one answer: the
// session override and a gesture's own Alt each switch the link off, and
// neither is consulted anywhere else.
describe("linkFanoutActive", () => {
  it.each([
    [false, false, true],
    [false, true, false],
    [true, false, false],
    [true, true, false],
  ])(
    "override %s, altKey %s → fans out %s",
    (override, altKey, expected) => {
      setLinkOverride(override);
      expect(linkFanoutActive({ altKey })).toBe(expected);
    },
  );

  it("reads the override alone when the site has no gesture", () => {
    expect(linkFanoutActive()).toBe(true);
    setLinkOverride(true);
    expect(linkFanoutActive()).toBe(false);
  });
});

describe("linkToggleForSelection", () => {
  it("links two or more unlinked layers, and needs two", () => {
    seed([]);
    expect(linkToggleForSelection()).toBe("needs_two");
    setLayerSelection("a", ["a"]);
    expect(linkToggleForSelection()).toBe("needs_two");
    setLayerSelection("a", ["a", "b"]);
    expect(linkToggleForSelection()).toBe("link");
  });

  it("is disabled with nothing selected, whatever links exist", () => {
    seed([{ id: "l1", label: null, layer_ids: ["a", "b"] }]);
    expect(linkToggleForSelection()).toBe("needs_two");
    expect(canToggleLinkSelection()).toBe(false);
  });

  // ONE member is enough to unlink: an `Alt`-click selects a single member
  // out of a link, and the whole-link selection a plain click produces is the
  // same case.
  it("unlinks a selection that sits inside one link", () => {
    seed([{ id: "l1", label: null, layer_ids: ["a", "b"] }]);
    setLayerSelection("a", ["a"]);
    expect(linkToggleForSelection()).toBe("unlink");
    setLayerSelection("a", ["a", "b"]);
    expect(linkToggleForSelection()).toBe("unlink");
    expect(canToggleLinkSelection()).toBe(true);
  });

  // Neither direction is honest for a mixed selection: linking would need
  // `reassign`, unlinking would drop members the user never selected.
  it("is disabled for a selection mixing linked and unlinked layers, or spanning two links", () => {
    seed([
      { id: "l1", label: null, layer_ids: ["a", "b"] },
      { id: "l2", label: null, layer_ids: ["c", "d"] },
    ]);
    setLayerSelection("a", ["a", "z"]);
    expect(linkToggleForSelection()).toBe("mixed");
    setLayerSelection("a", ["a", "c"]);
    expect(linkToggleForSelection()).toBe("mixed");
    expect(canToggleLinkSelection()).toBe(false);
  });

  // Both stores are read LIVE — the same rule `appCommands.ts` states for
  // `clearRange`. Unlinking through some other surface must not leave the
  // button reading "Unlink".
  it("follows the project store, not a snapshot", () => {
    seed([{ id: "l1", label: null, layer_ids: ["a", "b"] }]);
    setLayerSelection("a", ["a", "b"]);
    expect(linkToggleForSelection()).toBe("unlink");
    seed([]);
    // Re-selected, because a summary with no tracks prunes the selection too.
    setLayerSelection("a", ["a", "b"]);
    expect(linkToggleForSelection()).toBe("link");
  });
});

describe("enclosingLink", () => {
  it("names the link the handler dissolves, and null when there is none", () => {
    const links: LinkSummary[] = [
      { id: "l1", label: null, layer_ids: ["a", "b"] },
      { id: "l2", label: null, layer_ids: ["c", "d"] },
    ];
    expect(enclosingLink(new Set(["a", "b"]), links)?.id).toBe("l1");
    expect(enclosingLink(new Set(["d"]), links)?.id).toBe("l2");
    expect(enclosingLink(new Set(["a", "c"]), links)).toBeNull();
    expect(enclosingLink(new Set(), links)).toBeNull();
  });
});
