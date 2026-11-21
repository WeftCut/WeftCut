import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import { getCommand } from "../commands/registry";
import { useAgentActivity } from "../agent/activityStore";
import { Menu, MenuHeading, MenuItem, MenuSeparator, SubMenu } from "../menu/Menu";
import {
  useDisplayMode,
  useFollowPlayheadEnabled,
  useMarkersVisible,
  useSafeAreaGuidesVisible,
  usePreviewGridEnabled,
} from "../settings/appSettingsStore";
import {
  PANEL_KINDS,
  PANEL_REGISTRY,
} from "../workspace/panelRegistry";
import type {
  DockWorkspaceController,
  DockWorkspaceSnapshot,
} from "../workspace/dockWorkspaceAdapter";
import type { WorkspaceProfileInfo } from "../workspace/useWorkspacePersistence";

/// The View-menu Workspace controls, backed by the app-level Workspace document
/// (main-process store). The active-profile operations (Save / Rename / Delete)
/// are disabled for the immutable built-in Default Layout profile; Save As is
/// always available. Save As + Rename raise a name dialog owned by App, so
/// their menu handlers take no name here.
export interface ViewMenuWorkspaces {
  profiles: WorkspaceProfileInfo[];
  activeId: string;
  /** True when the active profile is the immutable built-in Default Layout profile. */
  activeIsBuiltin: boolean;
  onSwitch: (id: string) => void;
  onSave: () => void;
  onSaveAs: () => void;
  onReset: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
}

/// The View menu — Panels (open/focus/close) flat at the top, Workspace
/// profiles + management under the Workspaces submenu (low-frequency ops stay
/// one level down), then the two surface sections: Timeline (the A/B Roll vs
/// All Tracks mode, follow-playhead, markers, review overlay) and Preview
/// (safe-area guides, grid, Fit) — then the Agent-mode entry. Every
/// checkmark here reads the app-pref store, so it stays in sync however the
/// value changed — whether from `T` / `Shift+F`, the Quick Actions strip, or the
/// search palette.
///
/// Items with a command form are `CommandItem` rows: they dispatch through the
/// registry, whose funnel logs one `Shortcut` row per dispatch, same as the
/// chord (commands/registry.ts), and they are disabled whenever the command is.
/// The panel and workspace items are parameterized per-row ops with no command
/// form (see MENU_ONLY_COMMAND_IDS's reasoning in commands/appCommands.ts) and
/// stay raw.
interface ViewMenuProps {
  workspaceController: DockWorkspaceController | null;
  workspaceSnapshot: DockWorkspaceSnapshot;
  workspaceProfiles: ViewMenuWorkspaces | null;
}

export function ViewMenu({
  workspaceController,
  workspaceSnapshot,
  workspaceProfiles,
}: ViewMenuProps) {
  const { t } = useTranslation();
  const mode = useDisplayMode();
  const followPlayhead = useFollowPlayheadEnabled();
  const markersVisible = useMarkersVisible();
  const safeAreaGuides = useSafeAreaGuidesVisible();
  const gridEnabled = usePreviewGridEnabled();
  const reviewOverlay = useAgentActivity((s) => s.reviewOverlay);
  // Reset is a Workspace op (restore the active profile's saved baseline) when
  // profiles are wired; before they load it falls back to the adapter's built-in
  // rebuild so recovery is never dead.
  const onReset =
    workspaceProfiles?.onReset ??
    (workspaceController ? () => workspaceController.resetWorkspace() : undefined);
  return (
    <Menu label={t("menu.view", { defaultValue: "View" })}>
      <MenuHeading
        label={t("view.panels_heading", { defaultValue: "Panels" })}
      />
      {/* One entry per kind, checked when a Panel of it stands open — the menu
          names Panels, and "Timeline" is one row whatever composition the open
          timeline Panel is bound to. */}
      {PANEL_KINDS.map((kind) => (
        <MenuItem
          key={kind}
          label={t(PANEL_REGISTRY[kind].titleKey)}
          checked={workspaceSnapshot.openKinds.has(kind)}
          disabled={!workspaceController}
          onSelect={() => workspaceController?.openPanel(kind)}
        />
      ))}
      <MenuItem
        label={t("view.close_active_panel", {
          defaultValue: "Close Active Panel",
        })}
        disabled={!workspaceController || workspaceSnapshot.activePanel === null}
        onSelect={() => workspaceController?.closeActivePanel()}
      />
      <MenuSeparator />
      <SubMenu
        label={t("view.workspaces_heading", { defaultValue: "Workspaces" })}
      >
        {(workspaceProfiles?.profiles ?? []).map((profile) => (
          <MenuItem
            key={profile.id}
            label={
              profile.isBuiltin
                ? t("view.workspace_editing", { defaultValue: "Default Layout" })
                : profile.name
            }
            checked={profile.id === workspaceProfiles?.activeId}
            onSelect={() => workspaceProfiles?.onSwitch(profile.id)}
          />
        ))}
        <MenuSeparator />
        <MenuItem
          label={t("view.save_workspace", { defaultValue: "Save Workspace" })}
          disabled={!workspaceProfiles || workspaceProfiles.activeIsBuiltin}
          onSelect={() => workspaceProfiles?.onSave()}
        />
        <MenuItem
          label={t("view.save_workspace_as", {
            defaultValue: "Save as New Workspace…",
          })}
          disabled={!workspaceProfiles}
          onSelect={() => workspaceProfiles?.onSaveAs()}
        />
        <MenuItem
          label={t("view.rename_workspace", { defaultValue: "Rename Workspace…" })}
          disabled={!workspaceProfiles || workspaceProfiles.activeIsBuiltin}
          onSelect={() => {
            if (workspaceProfiles) workspaceProfiles.onRename(workspaceProfiles.activeId);
          }}
        />
        <MenuItem
          label={t("view.delete_workspace", { defaultValue: "Delete Workspace" })}
          disabled={!workspaceProfiles || workspaceProfiles.activeIsBuiltin}
          onSelect={() => {
            if (workspaceProfiles) workspaceProfiles.onDelete(workspaceProfiles.activeId);
          }}
        />
        {/* Reset is layout recovery, not profile management — and the only op
            available on the built-in profile — so it sits below its own
            separator. */}
        <MenuSeparator />
        <MenuItem
          label={t("view.reset_workspace", { defaultValue: "Reset Workspace" })}
          disabled={!onReset}
          onSelect={() => onReset?.()}
        />
      </SubMenu>
      <MenuSeparator />
      {/* The timeline's view controls, under one heading. The two display modes
          lead — they decide which rows exist before any overlay is read — and
          the overlays follow, in the order they paint. No separator inside:
          the heading is the group, and a divider under it would start a second,
          unheaded run. */}
      <MenuHeading
        label={t("view.timeline_heading", { defaultValue: "Timeline" })}
      />
      <CommandItem
        commandId="toggleDisplayMode"
        actionId="toggleDisplayMode"
        label={t("view.display_ab_roll", {
          defaultValue: "A/B Roll",
        })}
        checked={mode === "AbRoll"}
        runIf={mode !== "AbRoll"}
      />
      <CommandItem
        commandId="toggleDisplayMode"
        label={t("view.display_all_tracks", {
          defaultValue: "All Tracks",
        })}
        checked={mode === "AllTracks"}
        runIf={mode !== "AllTracks"}
      />
      <CommandItem
        commandId="toggleFollowPlayhead"
        actionId="toggleFollowPlayhead"
        label={t("view.follow_playhead", {
          defaultValue: "Timeline auto-scroll",
        })}
        checked={followPlayhead}
      />
      {/* Directly below Timeline auto-scroll: both are "how my timeline is
          displayed". No `actionId`, so no accelerator to right-align — see
          `MENU_ONLY_COMMAND_IDS` in `commands/appCommands.ts` for why this
          toggle has no binding. */}
      <CommandItem
        commandId="toggleMarkersVisible"
        label={t("view.timeline_markers", { defaultValue: "Timeline markers" })}
        checked={markersVisible}
      />
      {/* The Review overlay (ADR 0115): agent review material painted on the
          timeline — the Review lane of tack chips, unreviewed changes on the
          clips (edges, removed-clip ghosts, Group badges). Runtime state of the agent
          panel's store, like the material it shows; no binding. Last of the
          timeline rows: it shows agent material, not the user's own project. */}
      <CommandItem
        commandId="toggleReviewOverlay"
        label={t("view.review_overlay")}
        checked={reviewOverlay}
      />
      <MenuSeparator />
      {/* Preview chrome gets its own section instead of trailing the timeline
          rows: safe areas and the grid annotate the PREVIEW, and Fit resets its
          view, so a reader after timeline controls should not have to step
          through them. Both toggles are bindingless like the marker toggle —
          see `SELF_CONTAINED_COMMAND_IDS` in `commands/appCommands.ts`. */}
      <MenuHeading
        label={t("view.preview_heading", { defaultValue: "Preview" })}
      />
      <CommandItem
        commandId="toggleSafeAreaGuides"
        label={t("view.safe_area_guides", { defaultValue: "Safe-area guides" })}
        checked={safeAreaGuides}
      />
      <CommandItem
        commandId="togglePreviewGrid"
        label={t("view.grid", { defaultValue: "Grid" })}
        checked={gridEnabled}
      />
      {/* The preview's view, with its own chrome. Fit only: the two stepping
          commands read as an errand from a menu, and the toolbar's zoom
          readout is a menu of the scales already. Labelled from the command so
          the row, the palette and Settings → Keyboard cannot drift. */}
      <CommandItem
        commandId="previewZoomFit"
        actionId="previewZoomFit"
        label={t("actions.preview_zoom_fit")}
      />
      <MenuSeparator />
      {/* Enter path only: while a session is active the whole menu bar is
          swapped out for AgentMode, so exit stays on AgentMode's "Exit to
          editor" button. */}
      <CommandItem
        commandId="enterAgentMode"
        label={t("view.enter_agent_mode", { defaultValue: "Enter Agent Mode" })}
      />
    </Menu>
  );
}

/// A View-menu row backed by a registry command. `enabled` is read here, in the
/// row's own render, as `CommandMenu` reads it: Base UI mounts the popup on
/// open, so a lock that started after the menu bar rendered (an export holding
/// the project) still disables the row. An unregistered id stays a silent no-op.
function CommandItem({
  commandId,
  runIf = true,
  ...row
}: Omit<ComponentProps<typeof MenuItem>, "onSelect" | "disabled"> & {
  commandId: string;
  /// False for a radio row already in its state, whose select changes nothing.
  runIf?: boolean;
}) {
  const command = getCommand(commandId);
  return (
    <MenuItem
      {...row}
      disabled={command?.enabled ? !command.enabled() : false}
      onSelect={() => {
        if (runIf) void command?.run();
      }}
    />
  );
}
