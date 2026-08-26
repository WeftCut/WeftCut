import { describe, it, expect } from "vitest";

import {
  WEFTCUT_LAYOUT_VERSION,
  createEditingLayout,
  normalizeLayout,
  resolveWorkspaceLayout,
} from "./workspaceLayout";
import { DOCK_COMPONENT_ID, DOCK_TAB_COMPONENT_ID } from "./panelRegistry";

/** Build a leaf grid node (a Dock Group) for a set of Panel-kind views. */
function leaf(views: string[], extra: Record<string, unknown> = {}) {
  return {
    type: "leaf",
    data: { views, activeView: views[0], id: `g-${views.join("-")}`, ...extra },
    size: 100,
  };
}

function nonEmpty(root: unknown, grid: Record<string, unknown> = {}) {
  return {
    version: WEFTCUT_LAYOUT_VERSION,
    empty: false,
    dockview: {
      grid: { root, orientation: "HORIZONTAL", width: 1000, height: 720, ...grid },
      panels: {},
      activeGroup: "g-preview",
    },
  };
}

describe("normalizeLayout", () => {
  it("rejects non-objects and wrong versions", () => {
    expect(normalizeLayout(null)).toBeNull();
    expect(normalizeLayout(undefined)).toBeNull();
    expect(normalizeLayout("nope")).toBeNull();
    expect(normalizeLayout({ version: 999, empty: true })).toBeNull();
  });

  it("preserves an intentionally empty layout as a valid, distinct state", () => {
    expect(normalizeLayout({ version: WEFTCUT_LAYOUT_VERSION, empty: true })).toEqual({
      version: WEFTCUT_LAYOUT_VERSION,
      empty: true,
      dockview: null,
      placements: {},
    });
  });

  it("carries closed-Panel placement metadata through, dropping unknown kinds", () => {
    const result = normalizeLayout({
      version: WEFTCUT_LAYOUT_VERSION,
      empty: true,
      placements: {
        caption: { siblings: ["attribute", "caption"], index: 1 },
        bogus: { siblings: ["preview"], index: 0 },
        media: { siblings: [], index: 0 },
      },
    });
    expect(result?.placements).toEqual({
      caption: { siblings: ["attribute", "caption"], index: 1 },
    });
  });

  it("normalizes a simple split and regenerates the panels record from the registry", () => {
    const result = normalizeLayout(
      nonEmpty({
        type: "branch",
        data: [leaf(["media"]), leaf(["preview"]), leaf(["timeline"])],
        size: 720,
      }),
    );
    expect(result?.empty).toBe(false);
    const dockview = result!.dockview as unknown as {
      grid: { root: { data: unknown[] } };
      panels: Record<string, { contentComponent: string; tabComponent: string; params: unknown }>;
    };
    expect(Object.keys(dockview.panels).sort()).toEqual(["media", "preview", "timeline"]);
    // Panels are synthesized, not trusted from disk.
    expect(dockview.panels.preview).toMatchObject({
      contentComponent: DOCK_COMPONENT_ID,
      tabComponent: DOCK_TAB_COMPONENT_ID,
      params: { kind: "preview" },
      renderer: "always",
    });
    expect(dockview.grid.root.data).toHaveLength(3);
  });

  it("drops transient focus and maximize metadata", () => {
    const result = normalizeLayout(
      nonEmpty(leaf(["preview"]), {
        maximizedNode: { location: [0] },
      }),
    );
    const dockview = result!.dockview as unknown as {
      activeGroup?: string;
      grid: { maximizedNode?: unknown };
    };
    expect(dockview.activeGroup).toBeUndefined();
    expect(dockview.grid.maximizedNode).toBeUndefined();
  });

  it("drops unknown Panel kinds while keeping the known ones", () => {
    const result = normalizeLayout(
      nonEmpty({
        type: "branch",
        data: [leaf(["media", "totally-bogus"]), leaf(["preview"])],
      }),
    );
    const dockview = result!.dockview as unknown as { panels: Record<string, unknown> };
    expect(Object.keys(dockview.panels).sort()).toEqual(["media", "preview"]);
  });

  it("reduces a duplicated singleton to its first placement", () => {
    const result = normalizeLayout(
      nonEmpty({
        type: "branch",
        data: [leaf(["preview"]), leaf(["preview", "media"])],
      }),
    );
    const dockview = result!.dockview as unknown as {
      grid: { root: { data: Array<{ data: { views: string[] } }> } };
      panels: Record<string, unknown>;
    };
    expect(Object.keys(dockview.panels).sort()).toEqual(["media", "preview"]);
    // The second group keeps only the not-yet-seen kind.
    const groups = dockview.grid.root.data.map((n) => n.data.views);
    expect(groups).toEqual([["preview"], ["media"]]);
  });

  it("prunes an emptied leaf and collapses its single-child branch", () => {
    // The first leaf is all-unknown → pruned; the branch collapses to the survivor.
    const result = normalizeLayout(
      nonEmpty({
        type: "branch",
        data: [leaf(["bogus-a", "bogus-b"]), leaf(["timeline"])],
        size: 500,
      }),
    );
    const dockview = result!.dockview as unknown as {
      grid: { root: { type: string; data: { views: string[] } } };
    };
    expect(dockview.grid.root.type).toBe("leaf");
    expect(dockview.grid.root.data.views).toEqual(["timeline"]);
  });

  it("repairs an activeView that pointed at a dropped kind", () => {
    const result = normalizeLayout(
      nonEmpty(leaf(["media", "preview"], { activeView: "bogus" })),
    );
    const dockview = result!.dockview as unknown as {
      grid: { root: { data: { activeView: string } } };
    };
    expect(dockview.grid.root.data.activeView).toBe("media");
  });

  it("treats a non-empty layout that loses every Panel as corrupt (not empty)", () => {
    expect(normalizeLayout(nonEmpty(leaf(["bogus-1", "bogus-2"])))).toBeNull();
    expect(normalizeLayout(nonEmpty({ type: "branch", data: [] }))).toBeNull();
  });

  it("rejects a structurally broken tree", () => {
    expect(normalizeLayout({ version: WEFTCUT_LAYOUT_VERSION, empty: false, dockview: {} })).toBeNull();
    expect(
      normalizeLayout({ version: WEFTCUT_LAYOUT_VERSION, empty: false, dockview: { grid: {} } }),
    ).toBeNull();
  });
});

describe("createEditingLayout", () => {
  it("builds the strip + 22/53/25 by 72/28 baseline with Playhead over the inspector", () => {
    const result = createEditingLayout({ width: 1_000, height: 800 });
    // Axis/size semantics: see createEditingLayout's grid comment in
    // workspaceLayout.ts. Walked with one recursive shape rather than a
    // literal nesting depth: the right column added a fourth level, and a
    // hand-spelled type would have to be re-spelled for the fifth.
    type Node = {
      type: string;
      size: number;
      data: Node[] | { views: string[]; activeView: string; id: string };
    };
    const dockview = result.dockview as unknown as {
      grid: { orientation: string; width: number; height: number; root: Node };
      panels: Record<string, unknown>;
    };
    const kids = (node: Node): Node[] => {
      if (!Array.isArray(node.data)) throw new Error("expected a branch");
      return node.data;
    };
    const leaf = (node: Node) => {
      if (Array.isArray(node.data)) throw new Error("expected a leaf");
      return node.data;
    };

    expect(result).toMatchObject({ version: 1, empty: false });
    expect(dockview.grid).toMatchObject({
      orientation: "HORIZONTAL",
      width: 1_000,
      height: 800,
    });

    const [strip, body] = kids(dockview.grid.root);
    expect(strip).toMatchObject({ type: "leaf", size: 44 });
    expect(leaf(strip!).views).toEqual(["quick-actions"]);
    expect(body).toMatchObject({ type: "branch", size: 956 });

    // Body rows: the 72/28 editor/timeline split (sizes = heights).
    const [editor, timeline] = kids(body!);
    expect(editor).toMatchObject({ type: "branch", size: 576 });
    expect(timeline).toMatchObject({ type: "leaf", size: 224 });
    expect(leaf(timeline!).views).toEqual(["timeline"]);

    // Editor columns: library / Preview / the right column (sizes = widths).
    const [library, preview, right] = kids(editor!);
    expect(library).toMatchObject({ type: "leaf", size: 210 });
    expect(leaf(library!).views).toEqual(["media", "transitions"]);
    expect(preview).toMatchObject({ type: "leaf", size: 507 });
    expect(leaf(preview!).views).toEqual(["preview"]);

    // The right column alternates back to vertical: the Playhead Panel gets
    // 40% of the editor row on its own, the inspector tabs the remainder.
    expect(right).toMatchObject({ type: "branch", size: 239 });
    const [playhead, inspector] = kids(right!);
    expect(playhead).toMatchObject({ type: "leaf", size: 230 });
    expect(leaf(playhead!)).toMatchObject({
      views: ["playhead"],
      activeView: "playhead",
      id: "editing-playhead",
    });
    expect(inspector).toMatchObject({ type: "leaf", size: 346 });
    expect(leaf(inspector!)).toMatchObject({
      views: ["attribute", "effect"],
      activeView: "attribute",
      id: "editing-context",
    });

    expect(Object.keys(dockview.panels).sort()).toEqual([
      "attribute",
      "effect",
      "media",
      "playhead",
      "preview",
      "quick-actions",
      "timeline",
      "transitions",
    ]);
    // Placements are the reopen map: Playhead now remembers a group of its
    // own, so closing and reopening it must not fold it back into Attribute.
    expect(result.placements.playhead).toEqual({ siblings: ["playhead"], index: 0 });
    expect(result.placements.effect).toEqual({
      siblings: ["attribute", "effect"],
      index: 1,
    });
    expect(result.placements["quick-actions"]).toEqual({
      siblings: ["quick-actions"],
      index: 0,
    });
  });

  it("falls back to usable dimensions for an unmeasured viewport", () => {
    const result = createEditingLayout({ width: 0, height: Number.NaN });
    expect(result.dockview).toMatchObject({
      grid: { width: 1_000, height: 720 },
    });
  });
});

describe("resolveWorkspaceLayout", () => {
  const validCurrent = nonEmpty(leaf(["preview"]));
  const validSaved = nonEmpty(leaf(["timeline"]));

  it("returns an empty candidate list for a missing profile", () => {
    expect(resolveWorkspaceLayout(null)).toEqual([]);
    expect(resolveWorkspaceLayout({ current: null, saved: null })).toEqual([]);
  });

  it("orders current before saved when both are valid", () => {
    const candidates = resolveWorkspaceLayout({ current: validCurrent, saved: validSaved });
    expect(candidates.map((c) => c.source)).toEqual(["current", "saved"]);
  });

  it("falls through a corrupt current to a valid saved baseline", () => {
    const candidates = resolveWorkspaceLayout({
      current: { version: WEFTCUT_LAYOUT_VERSION, empty: false, dockview: { grid: {} } },
      saved: validSaved,
    });
    expect(candidates.map((c) => c.source)).toEqual(["saved"]);
  });

  it("includes an intentionally empty current as a valid candidate", () => {
    const candidates = resolveWorkspaceLayout({
      current: { version: WEFTCUT_LAYOUT_VERSION, empty: true },
      saved: null,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ source: "current", layout: { empty: true } });
  });
});
