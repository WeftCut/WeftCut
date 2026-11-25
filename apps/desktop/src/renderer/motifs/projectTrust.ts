// The open project's trust state and the one dialog that decides it
// (ADR 0182). Module-level because four surfaces reach the dialog (the
// open-time prompt, File menu, Motifs panel, property panel) and the menu label
// reads the state. The dialog itself is `ProjectTrustDialog.tsx`.
import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@/bridge/events";
import i18n from "../i18n";
import { notifyCommandRegistry } from "../commands/registry";
import { logMutationFailure } from "../errors/tryMutate";
import {
  MOTIFS_CHANGED_EVENT,
  projectTrustSummary,
  untrustProject,
  type ProjectTrustMotif,
  type ProjectTrustSummary,
} from "../ipc";

interface ProjectTrustState {
  /// The last state read, without file summaries; null until the first read.
  summary: ProjectTrustSummary | null;
  /// Whether App's host shows the dialog.
  open: boolean;
}

export const useProjectTrust = create<ProjectTrustState>(() => ({ summary: null, open: false }));

/// Bumped by every read and by `resetProjectTrust`, so a read that lands after
/// a newer one, or after its project closed, is dropped.
let generation = 0;

export function openProjectTrustDialog(): void {
  useProjectTrust.setState({ open: true });
}

export function closeProjectTrustDialog(): void {
  useProjectTrust.setState({ open: false });
}

/// Reads the state again. Never opens the dialog: only opening a project asks.
export async function refreshProjectTrust(): Promise<ProjectTrustSummary | null> {
  const mine = ++generation;
  let summary: ProjectTrustSummary;
  try {
    summary = await projectTrustSummary({ summaries: false });
  } catch (e) {
    if (mine === generation) logMutationFailure(e, "Read project trust");
    return null;
  }
  if (mine !== generation) return null;
  useProjectTrust.setState({ summary });
  // The File menu's label follows `trusted`.
  notifyCommandRegistry();
  return summary;
}

function resetProjectTrust(): void {
  generation++;
  useProjectTrust.setState({ summary: null, open: false });
  notifyCommandRegistry();
}

/// The open-time prompt, and the state kept current while the project is
/// open. Called once, from App's wiring: App mounts once per opened project.
export function useProjectTrustPrompt(): void {
  useEffect(() => {
    let cancelled = false;
    // Decided on the first state that lands, whichever read brings it: a
    // change during the first read supersedes it, and must not skip the ask.
    let decided = false;
    const decide = (summary: ProjectTrustSummary | null) => {
      if (cancelled || decided || !summary) return;
      decided = true;
      if (summary.prompt) openProjectTrustDialog();
    };
    void refreshProjectTrust().then(decide);
    let stop: (() => void) | undefined;
    // Trust and untrust send it too, whichever surface asked.
    void listen(MOTIFS_CHANGED_EVENT, () => void refreshProjectTrust().then(decide)).then((un) => {
      if (cancelled) un(); else stop = un;
    });
    return () => {
      cancelled = true;
      stop?.();
      resetProjectTrust();
    };
  }, []);
}

/// The File menu item's label: what choosing it does.
export function projectTrustLabelKey(): string {
  return useProjectTrust.getState().summary?.trusted ? "actions.untrust_project" : "actions.project_trust";
}

/// File > Trust this project… opens the dialog; on a trusted project the same
/// item stops trusting it at once, with no confirmation (ADR 0182).
export async function runProjectTrustCommand(): Promise<void> {
  if (!useProjectTrust.getState().summary?.trusted) {
    openProjectTrustDialog();
    return;
  }
  try {
    await untrustProject();
  } catch (e) {
    logMutationFailure(e, "Stop trusting project");
  }
  await refreshProjectTrust();
}

/// What "Ask an agent to check first" copies. Names Motifs by id only: a
/// manifest's name is the project's own text, and would be pasted into the
/// agent's instructions.
export function agentCheckPrompt(project: string, motifs: readonly Pick<ProjectTrustMotif, "motif_id">[]): string {
  return i18n.t("project_trust.agent_prompt", {
    project,
    ids: motifs.map((m) => m.motif_id).join(", "),
  });
}
