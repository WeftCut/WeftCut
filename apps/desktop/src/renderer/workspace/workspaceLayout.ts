// Renderer-owned schema and validation for opaque Workspace layout slots.
// Main never interprets this shape; the persistence hook owns fallback
// selection and repair.

import type { SerializedDockview } from "dockview-react";

import {
  DOCK_COMPONENT_ID,
  DOCK_TAB_COMPONENT_ID,
  PANEL_REGISTRY,
  STRIP_THICKNESS,
  panelIdOf,
  panelTitle,
  parsePanelId,
  type DockPanelParams,
  type PanelId,
} from "./panelRegistry";

/** Schema version of a WeftCut layout snapshot. Bump on any incompatible change
 *  to the snapshot shape; a snapshot with a different version is discarded on
 *  read (falls through to the next fallback level) rather than misapplied. */
export const WEFTCUT_LAYOUT_VERSION = 1;

/** Recovery metadata for reopening a Panel: the Dock Group it last lived in
 *  (as sibling ids) and its tab index there. Mirrors the adapter's in-memory
 *  placement map so a closed Panel reopens at its remembered spot after restart. */
export interface PanelPlacement {
  siblings: PanelId[];
  index: number;
}

export type PanelPlacements = Partial<Record<PanelId, PanelPlacement>>;

/** A validated, versioned Dock arrangement. Opaque to everyone but the adapter
 *  (which restores it) and this module (which produces/validates it). The `empty`
 *  discriminant makes an intentionally empty Workspace a distinct valid state. */
export interface WeftCutLayout {
  version: number;
  empty: boolean;
  /** The normalized Dockview tree. Null iff `empty`. */
  dockview: SerializedDockview | null;
  /** Last-known placement of every Panel, open or closed. May be empty. */
  placements: PanelPlacements;
}

export interface WorkspaceLayoutCandidate {
  source: "current" | "saved";
  layout: WeftCutLayout;
}

// ── Internal loose tree shapes ───────────────────────────────────────────────
// We rebuild the grid tree from untrusted input, so we work with permissive local
// types and cast the finished, canonical object to SerializedDockview once — the
// Dockview enums (Orientation) are nominal and awkward to satisfy field-by-field.

interface NormalizedLeaf {
  type: "leaf";
  data: { views: PanelId[]; activeView: PanelId; id: string };
  size?: number;
  visible?: boolean;
}

interface NormalizedBranch {
  type: "branch";
  data: NormalizedNode[];
  size?: number;
  visible?: boolean;
}

type NormalizedNode = NormalizedLeaf | NormalizedBranch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Regenerate a Panel definition from its id. Everything about a Panel but its
 *  address (title, components, params, constraints) follows from its kind, so
 *  the persisted `panels` record is derived here rather than trusted — a corrupt
 *  or stale entry can never carry a wrong component id or params into fromJSON. */
function synthesizePanel(id: PanelId) {
  const { kind, instance } = parsePanelId(id);
  const definition = PANEL_REGISTRY[kind];
  const params: DockPanelParams = { kind, instance };
  return {
    id,
    contentComponent: DOCK_COMPONENT_ID,
    tabComponent: DOCK_TAB_COMPONENT_ID,
    title: panelTitle(kind),
    renderer: "always" as const,
    params,
    minimumWidth: definition.minimumWidth,
    minimumHeight: definition.minimumHeight,
  };
}

/** Re-address one Panel id on the way through a normalization pass. */
type Readdress = (id: PanelId) => PanelId;

/** This pass's re-addressing rule, from `NormalizeLayoutOptions.timelineInstance`. */
function readdressor(instance: string | null | undefined): Readdress {
  if (instance === undefined) return (id) => id;
  const timeline = panelIdOf("timeline", instance);
  return (id) => (parsePanelId(id).kind === "timeline" ? timeline : id);
}

/** An untrusted id as the address this pass will use it under, or null when the
 *  catalogue cannot resolve it. */
function panelIdIn(value: unknown, readdress: Readdress): PanelId | null {
  const parsed = parsePanelId(value);
  return parsed ? readdress(panelIdOf(parsed.kind, parsed.instance)) : null;
}

/**
 * Normalize one grid node. `seen` carries the ids already claimed by earlier
 * leaves so a duplicated singleton is reduced to its first placement. Returns
 * null for a node that contributes nothing (empty leaf / empty branch) so the
 * parent can prune it.
 */
function normalizeNode(
  node: unknown,
  seen: Set<PanelId>,
  readdress: Readdress,
): NormalizedNode | null {
  if (!isRecord(node)) return null;

  const size = sizeOf(node.size);

  if (node.type === "branch") {
    if (!Array.isArray(node.data)) return null;
    const children: NormalizedNode[] = [];
    for (const child of node.data) {
      const normalized = normalizeNode(child, seen, readdress);
      if (normalized) children.push(normalized);
    }
    if (children.length === 0) return null;
    // A branch with a single surviving child is degenerate; hoist the child and
    // carry this branch's size so the remaining split keeps its proportion.
    if (children.length === 1) {
      const only = children[0]!;
      const kept = size ?? only.size;
      return kept === undefined ? only : { ...only, size: kept };
    }
    return { type: "branch", data: children, ...(size === undefined ? {} : { size }) };
  }

  // Leaf (default): a Dock Group with one or more tabbed Panels.
  const data = node.data;
  if (!isRecord(data)) return null;
  const rawViews = Array.isArray(data.views) ? data.views : [];
  const views: PanelId[] = [];
  for (const view of rawViews) {
    const id = panelIdIn(view, readdress);
    if (id !== null && !seen.has(id)) {
      views.push(id);
      seen.add(id);
    }
  }
  const first = views[0];
  if (first === undefined) return null;
  const requestedActive = panelIdIn(data.activeView, readdress);
  const activeView =
    requestedActive !== null && views.includes(requestedActive)
      ? requestedActive
      : first;
  const id = typeof data.id === "string" && data.id ? data.id : `group-${first}`;
  return {
    type: "leaf",
    data: { views, activeView, id },
    ...(size === undefined ? {} : { size }),
    ...(node.visible === false ? { visible: false } : {}),
  };
}

function sizeOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeDockview(
  raw: unknown,
  readdress: Readdress,
): SerializedDockview | null {
  if (!isRecord(raw)) return null;
  const grid = raw.grid;
  if (!isRecord(grid)) return null;

  const seen = new Set<PanelId>();
  const root = normalizeNode(grid.root, seen, readdress);
  // A layout that claimed to be non-empty but lost every Panel to
  // unknown-kind/duplicate pruning is corrupt, not intentionally empty — reject
  // it so the caller falls through to the next fallback level.
  if (!root || seen.size === 0) return null;

  const panels: Record<string, ReturnType<typeof synthesizePanel>> = {};
  for (const id of seen) panels[id] = synthesizePanel(id);

  const orientation = grid.orientation === "VERTICAL" ? "VERTICAL" : "HORIZONTAL";
  const width = sizeOf(grid.width) ?? 1_000;
  const height = sizeOf(grid.height) ?? 720;
  const normalized = {
    grid: { root, orientation, width, height },
    panels,
  };
  return normalized as unknown as SerializedDockview;
}

function normalizePlacements(
  raw: unknown,
  readdress: Readdress,
): PanelPlacements {
  const out: PanelPlacements = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const id = panelIdIn(key, readdress);
    if (id === null || !isRecord(value)) continue;
    const siblings = Array.isArray(value.siblings)
      ? value.siblings.flatMap((sibling) => {
          const resolved = panelIdIn(sibling, readdress);
          return resolved === null ? [] : [resolved];
        })
      : [];
    if (siblings.length === 0) continue;
    const index =
      typeof value.index === "number" && value.index >= 0
        ? Math.floor(value.index)
        : 0;
    out[id] = { siblings, index };
  }
  return out;
}

export interface NormalizeLayoutOptions {
  /**
   * Re-address every timeline Panel found, whatever address it arrived under: a
   * composition id binds the row to that composition, `null` folds it back to
   * the single `timeline` slot a snapshot stores (ADR 0053). Omitting the field
   * — which is not the same as passing `null` — leaves each id exactly as found,
   * which is what a caller with no opinion wants: the persistence layer
   * validating a document off disk has no composition to name.
   */
  timelineInstance?: string | null;
}

/**
 * Validate + normalize an untrusted persisted layout value. Returns a canonical
 * WeftCutLayout, or null when the value is missing/corrupt/unrecoverable.
 */
export function normalizeLayout(
  raw: unknown,
  options: NormalizeLayoutOptions = {},
): WeftCutLayout | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== WEFTCUT_LAYOUT_VERSION) return null;
  const readdress = readdressor(options.timelineInstance);
  const placements = normalizePlacements(raw.placements, readdress);
  if (raw.empty === true) {
    return { version: WEFTCUT_LAYOUT_VERSION, empty: true, dockview: null, placements };
  }
  const dockview = normalizeDockview(raw.dockview, readdress);
  if (!dockview) return null;
  return { version: WEFTCUT_LAYOUT_VERSION, empty: false, dockview, placements };
}

/**
 * Produce the immutable, code-owned Editing baseline as a complete Dockview
 * snapshot. Reset applies this snapshot in one Dockview load transaction; it
 * must not clear the tree and then rebuild Panels one at a time because a
 * transiently missing reference Panel would strand the Workspace half-built.
 */
export function createEditingLayout(
  viewport: { width?: number; height?: number } = {},
): WeftCutLayout {
  const width = sizeOf(viewport.width) ?? 1_000;
  const height = sizeOf(viewport.height) ?? 720;
  const contextual: PanelId[] = ["attribute", "effect"];
  const library: PanelId[] = ["media", "transitions"];
  const placements: PanelPlacements = {
    "quick-actions": { siblings: ["quick-actions"], index: 0 },
    media: { siblings: library, index: 0 },
    transitions: { siblings: library, index: 1 },
    preview: { siblings: ["preview"], index: 0 },
    timeline: { siblings: ["timeline"], index: 0 },
    playhead: { siblings: ["playhead"], index: 0 },
    attribute: { siblings: contextual, index: 0 },
    effect: { siblings: contextual, index: 1 },
  };
  // The Quick Actions strip is a full-height edge bar, so it claims a fixed
  // slice of the remaining editor width rather than a proportion.
  const stripWidth = STRIP_THICKNESS;
  const bodyWidth = Math.max(1, width - stripWidth);
  const editorHeight = Math.round(height * 0.72);
  const timelineHeight = Math.round(height * 0.28);
  const columnWidth = Math.round(bodyWidth * 0.25);
  /* The Playhead Panel owns the top of the right column outright instead of
   * sleeping behind an Attribute tab: A/B-Roll is the editing model this app
   * defaults to, and the stack under the playhead is what that model is read
   * from — a user who never finds the tab never learns the model. The
   * inspector keeps the larger share below it because it holds far more rows
   * than the stack ever does. */
  const playheadHeight = Math.round(editorHeight * 0.4);
  const layout = normalizeLayout({
    version: WEFTCUT_LAYOUT_VERSION,
    empty: false,
    dockview: {
      grid: {
        // Grid branches ALTERNATE axes, and a node's `size` is measured along
        // its PARENT's axis. A horizontal root gives the full-height Quick
        // Actions strip beside everything else (sizes = widths); the body
        // branch then alternates to vertical for the 72/28 editor/timeline
        // rows (sizes = heights); the editor row alternates back to horizontal
        // for its three columns (sizes = widths); and the right column
        // alternates once more to vertical for Playhead over the inspector
        // (sizes = heights again).
        orientation: "HORIZONTAL",
        width,
        height,
        root: {
          type: "branch",
          size: width,
          data: [
            {
              type: "leaf",
              size: stripWidth,
              data: {
                id: "editing-quick-actions",
                views: ["quick-actions"],
                activeView: "quick-actions",
              },
            },
            {
              type: "branch",
              size: bodyWidth,
              data: [
                {
                  type: "branch",
                  size: editorHeight,
                  data: [
                    {
                      type: "leaf",
                      size: Math.round(bodyWidth * 0.22),
                      data: {
                        id: "editing-media",
                        views: library,
                        activeView: "media",
                      },
                    },
                    {
                      type: "leaf",
                      size: Math.round(bodyWidth * 0.53),
                      data: {
                        id: "editing-preview",
                        views: ["preview"],
                        activeView: "preview",
                      },
                    },
                    {
                      type: "branch",
                      size: columnWidth,
                      data: [
                        {
                          type: "leaf",
                          size: playheadHeight,
                          data: {
                            id: "editing-playhead",
                            views: ["playhead"],
                            activeView: "playhead",
                          },
                        },
                        {
                          type: "leaf",
                          size: editorHeight - playheadHeight,
                          data: {
                            id: "editing-context",
                            views: contextual,
                            activeView: "attribute",
                          },
                        },
                      ],
                    },
                  ],
                },
                {
                  type: "leaf",
                  size: timelineHeight,
                  data: {
                    id: "editing-timeline",
                    views: ["timeline"],
                    activeView: "timeline",
                  },
                },
              ],
            },
          ],
        },
      },
      // normalizeLayout derives trusted definitions for every referenced Panel.
      panels: {},
    },
    placements,
  });
  if (!layout) throw new Error("Built-in Editing layout is invalid");
  return layout;
}

/**
 * Turn a Workspace profile's opaque layout slots into the ordered restore
 * candidates: `current` first, then the saved baseline. Each is included only
 * when it normalizes to a valid layout. An empty result means the caller should
 * fall back to the built-in Editing baseline.
 */
export function resolveWorkspaceLayout(
  slots: { current?: unknown; saved?: unknown } | null | undefined,
): WorkspaceLayoutCandidate[] {
  const candidates: WorkspaceLayoutCandidate[] = [];
  const current = normalizeLayout(slots?.current);
  if (current) candidates.push({ source: "current", layout: current });
  const saved = normalizeLayout(slots?.saved);
  if (saved) candidates.push({ source: "saved", layout: saved });
  return candidates;
}
