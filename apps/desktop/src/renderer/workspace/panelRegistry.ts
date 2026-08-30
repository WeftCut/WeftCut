import i18n from "../i18n";

/** Dockview component ids for the single WeftCut Panel + tab renderers. Kept
 *  here (not in the adapter) so the persistence layer can synthesize Panel
 *  definitions on restore without importing the adapter — keeping the module
 *  graph one-directional (adapter → workspaceLayout, never the reverse). */
export const DOCK_COMPONENT_ID = "weftcut-panel";
export const DOCK_TAB_COMPONENT_ID = "weftcut-tab";

export const PANEL_KINDS = [
  "media",
  "transitions",
  "preview",
  "timeline",
  "quick-actions",
  "attribute",
  "caption",
  "marker",
  "role-mixer",
  "effect",
  "playhead",
  "agent",
  "history",
] as const;

export type PanelKind = (typeof PANEL_KINDS)[number];

export interface PanelDefinition {
  kind: PanelKind;
  titleKey: `dock_workspace.panels.${PanelKind}`;
  minimumWidth: number;
  minimumHeight: number;
  initiallyOpen: boolean;
}

const TOOL_MINIMUM = { minimumWidth: 240, minimumHeight: 160 } as const;

/**
 * The Quick Actions bar's thickness across its short axis, and equally the
 * floor on both axes: one button plus the drag grip is all the strip ever needs
 * in either direction, and `TOOL_MINIMUM`'s 240 px would pin the bar ~5.5× too
 * wide. Overflow scrolls, so this never hides a command permanently.
 *
 * Floor and thickness are ONE number on purpose: the strip's short axis is
 * pinned by holding its Group to `minimum === maximum` (see
 * `useFixedStripThickness` in DockWorkspace.tsx), which is only legal while the
 * thickness is not below the floor.
 */
export const STRIP_THICKNESS = 44;

const STRIP_MINIMUM = {
  minimumWidth: STRIP_THICKNESS,
  minimumHeight: STRIP_THICKNESS,
} as const;

/**
 * The complete Panel catalogue, keyed by kind. A kind is what every Panel of it
 * shares — title, size minimums, whether the Editing baseline opens it — and it
 * is what a menu entry, a shortcut scope and a command all address a Panel by.
 *
 * Kind is not identity. The Dockview address is a `PanelId`, and `timeline` is
 * the only kind that instantiates: one Panel per composition, never two, since
 * a composition has one set of tracks and a second Panel on it would draw
 * byte-identical rows. See ADR 0053.
 */
export const PANEL_REGISTRY: Readonly<Record<PanelKind, PanelDefinition>> = {
  media: {
    kind: "media",
    titleKey: "dock_workspace.panels.media",
    minimumWidth: 240,
    minimumHeight: 160,
    initiallyOpen: true,
  },
  // Open by default and tabbed with the Media Pool (see createEditingLayout):
  // the panel EXISTS to be stumbled over (#16 — transition authoring was
  // unreachable without knowing the right-click-on-a-cut gesture), so hiding
  // it behind the View menu would defeat it.
  transitions: {
    kind: "transitions",
    titleKey: "dock_workspace.panels.transitions",
    ...TOOL_MINIMUM,
    initiallyOpen: true,
  },
  preview: {
    kind: "preview",
    titleKey: "dock_workspace.panels.preview",
    minimumWidth: 320,
    minimumHeight: 180,
    initiallyOpen: true,
  },
  timeline: {
    kind: "timeline",
    titleKey: "dock_workspace.panels.timeline",
    minimumWidth: 420,
    minimumHeight: 180,
    initiallyOpen: true,
  },
  "quick-actions": {
    kind: "quick-actions",
    titleKey: "dock_workspace.panels.quick-actions",
    ...STRIP_MINIMUM,
    initiallyOpen: true,
  },
  attribute: {
    kind: "attribute",
    titleKey: "dock_workspace.panels.attribute",
    ...TOOL_MINIMUM,
    initiallyOpen: true,
  },
  caption: {
    kind: "caption",
    titleKey: "dock_workspace.panels.caption",
    ...TOOL_MINIMUM,
    initiallyOpen: false,
  },
  // Closed by default, and the one Panel whose absence LOSES something: a
  // hibernating marker is painted on no lane, so this is the only surface that
  // shows one (ADR 0056). It opens on demand all the same — a marker the user
  // has not gone looking for is not worth a permanent lane of screen.
  marker: {
    kind: "marker",
    titleKey: "dock_workspace.panels.marker",
    ...TOOL_MINIMUM,
    initiallyOpen: false,
  },
  "role-mixer": {
    kind: "role-mixer",
    titleKey: "dock_workspace.panels.role-mixer",
    ...TOOL_MINIMUM,
    initiallyOpen: false,
  },
  effect: {
    kind: "effect",
    titleKey: "dock_workspace.panels.effect",
    ...TOOL_MINIMUM,
    initiallyOpen: true,
  },
  playhead: {
    kind: "playhead",
    titleKey: "dock_workspace.panels.playhead",
    ...TOOL_MINIMUM,
    initiallyOpen: true,
  },
  agent: {
    kind: "agent",
    titleKey: "dock_workspace.panels.agent",
    ...TOOL_MINIMUM,
    initiallyOpen: false,
  },
  // Closed by default like the other on-demand tool Panels: the edit stack is
  // pulled over its own IPC channel (`project_history_view`), so a closed
  // History Panel costs exactly zero refetches — see spec decision 5.
  history: {
    kind: "history",
    titleKey: "dock_workspace.panels.history",
    ...TOOL_MINIMUM,
    initiallyOpen: false,
  },
};

export function panelTitle(kind: PanelKind): string {
  return i18n.t(PANEL_REGISTRY[kind].titleKey);
}

export const EDITING_OPEN_PANEL_KINDS = PANEL_KINDS.filter(
  (kind) => PANEL_REGISTRY[kind].initiallyOpen,
);

export function isPanelKind(value: unknown): value is PanelKind {
  return (
    typeof value === "string" &&
    (PANEL_KINDS as readonly string[]).includes(value)
  );
}

/** The kinds that exist once per composition rather than once per app. */
const INSTANCING_PANEL_KINDS = ["timeline"] as const;

type InstancingPanelKind = (typeof INSTANCING_PANEL_KINDS)[number];

/**
 * A Panel's Dockview address. Most kinds are addressed by the kind alone; a
 * timeline Panel names the composition it shows, so it is `timeline:<id>`.
 *
 * The bare `timeline` form is the unbound one, and it is load-bearing twice
 * over: a layout snapshot stores it — `workspaces.json` spans every project and
 * every saved profile, so no composition uuid may enter it (ADR 0053) — and the
 * live Dock carries it for as long as no project summary has named a root.
 */
export type PanelId = PanelKind | `${InstancingPanelKind}:${string}`;

/** Splits a Panel id's kind from its instance. Spelled here and nowhere else:
 *  `panelIdOf` and `parsePanelId` are the whole vocabulary. */
const PANEL_ID_SEPARATOR = ":";

export interface ParsedPanelId {
  kind: PanelKind;
  /** The composition a timeline Panel shows; null for an id that is a bare kind. */
  instance: string | null;
}

function isInstancingPanelKind(value: string): value is InstancingPanelKind {
  return (INSTANCING_PANEL_KINDS as readonly string[]).includes(value);
}

/** Compose a Panel's address. An instance on a kind that does not instantiate
 *  is dropped — the catalogue could not resolve the id it would produce. */
export function panelIdOf(kind: PanelKind, instance?: string | null): PanelId {
  return instance && isInstancingPanelKind(kind)
    ? `${kind}${PANEL_ID_SEPARATOR}${instance}`
    : kind;
}

/** Read a Panel address back into the catalogue key and the instance behind it.
 *  Anything the catalogue cannot resolve — a foreign Dockview panel, a kind a
 *  stale snapshot still names, an instance on a kind that has none — is
 *  rejected rather than guessed at. */
export function parsePanelId(value: PanelId): ParsedPanelId;
export function parsePanelId(value: unknown): ParsedPanelId | null;
export function parsePanelId(value: unknown): ParsedPanelId | null {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(PANEL_ID_SEPARATOR);
  if (separator === -1) {
    return isPanelKind(value) ? { kind: value, instance: null } : null;
  }
  const kind = value.slice(0, separator);
  const instance = value.slice(separator + 1);
  if (!isInstancingPanelKind(kind) || !instance) return null;
  return { kind, instance };
}

/** What a WeftCut Panel carries in its Dockview `params`: both halves of its
 *  own address, so a Panel never parses the id it was mounted under. */
export interface DockPanelParams extends Record<string, unknown> {
  kind: PanelKind;
  instance: string | null;
}
