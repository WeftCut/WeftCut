// The one dialog that decides whether the open project's Motifs run
// (ADR 0182): the waiting Motifs read as text by main (`trustSummary.ts`),
// Later, and Trust this project. Trust names the revisions the dialog shows,
// so a folder that changed since is shown again rather than trusted unseen.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { listen } from "@/bridge/events";
import { AppDialog } from "../components/AppDialog";
import { logMutationFailure, refusalText } from "../errors/tryMutate";
import { formatBytes } from "../lib/formatBytes";
import {
  dismissProjectTrust,
  MOTIFS_CHANGED_EVENT,
  projectTrustSummary,
  trustProject,
  type ProjectTrustMotif,
  type ProjectTrustSummary,
} from "../ipc";
import {
  agentCheckPrompt,
  closeProjectTrustDialog,
  refreshProjectTrust,
  useProjectTrust,
} from "./projectTrust";

/** The App-level dialog, open while the store says so. The Motifs panel,
 *  itself a dialog, renders its own `ProjectTrustDialog` stacked on it. */
export function ProjectTrustHost() {
  const open = useProjectTrust((s) => s.open);
  return open ? <ProjectTrustDialog onClose={closeProjectTrustDialog} /> : null;
}

/** Same ids at the same revisions: what Trust would send is what was shown. */
function sameMotifs(a: readonly ProjectTrustMotif[], b: readonly ProjectTrustMotif[]): boolean {
  return a.length === b.length && a.every((m, i) => m.motif_id === b[i]!.motif_id && m.revision === b[i]!.revision);
}

/** `onClose` runs once, whether the user trusted, chose Later or the project
 *  turned out trusted already; only Later (and ✕, Escape, the backdrop)
 *  records the dismissal. */
export function ProjectTrustDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<ProjectTrustSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  const closed = useRef(false);
  const generation = useRef(0);
  /** The list on screen, for reads that land outside a render. */
  const shown = useRef<ProjectTrustSummary | null>(null);

  const close = () => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  };

  /** The state now, with summaries; null when superseded, closed or failed. */
  const read = async (): Promise<ProjectTrustSummary | null> => {
    const mine = ++generation.current;
    try {
      const next = await projectTrustSummary({ summaries: true });
      return alive.current && mine === generation.current ? next : null;
    } catch (e) {
      if (alive.current && mine === generation.current) setError(refusalText(e));
      return null;
    }
  };

  /** Shows `next`; a list that differs from the one on screen says so and opens. */
  const take = (next: ProjectTrustSummary) => {
    if (next.trusted) { close(); return; }
    const before = shown.current;
    if (before && !sameMotifs(before.motifs, next.motifs)) {
      setChanged(true);
      setListOpen(true);
    }
    shown.current = next;
    setSummary(next);
    setError(null);
  };

  useEffect(() => {
    alive.current = true;
    const load = () => void read().then((next) => { if (next) take(next); });
    load();
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen(MOTIFS_CHANGED_EVENT, load).then((un) => {
      if (cancelled) un(); else stop = un;
    });
    return () => {
      alive.current = false;
      cancelled = true;
      stop?.();
    };
    // `read` and `take` close over refs and state setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trust = async () => {
    const seen = shown.current;
    if (!seen || busy) return;
    setBusy(true);
    setError(null);
    setChanged(false);
    try {
      await trustProject(Object.fromEntries(seen.motifs.map((m) => [m.motif_id, m.revision])));
      void refreshProjectTrust();
      close();
    } catch (e) {
      const now = await read();
      if (!alive.current) return;
      if (now && (now.trusted || !sameMotifs(seen.motifs, now.motifs))) take(now);
      else if (now) setError(refusalText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const later = () => {
    void dismissProjectTrust().then(() => refreshProjectTrust(), (e) => logMutationFailure(e, "Dismiss project trust"));
    close();
  };

  const askAgent = () => {
    if (!summary) return;
    setCopied(false);
    navigator.clipboard.writeText(agentCheckPrompt(summary.project, summary.motifs)).then(
      () => { if (alive.current) setCopied(true); },
      (e: unknown) => { if (alive.current) setError(refusalText(e)); },
    );
  };

  const count = summary?.motifs.length ?? 0;
  return (
    <AppDialog
      title={t("project_trust.title")}
      panelClassName="settings-panel portability-dialog"
      onClose={busy ? undefined : later}
    >
      <div className="settings-body">
        <div className="settings-card">
          {summary ? (
            <>
              <p className="settings-blurb">
                {count > 0
                  ? t("project_trust.lead", { project: summary.project, count })
                  : t("project_trust.lead_none", { project: summary.project })}
              </p>
              {changed && <p className="settings-status" role="status">{t("project_trust.changed")}</p>}
              {count > 0 && (
                <details
                  className="project-trust-list"
                  open={listOpen}
                  onToggle={(e) => setListOpen(e.currentTarget.open)}
                >
                  <summary>{t("project_trust.show", { count })}</summary>
                  <ul className="portability-list">
                    {summary.motifs.map((m) => <TrustRow key={m.motif_id} motif={m} />)}
                  </ul>
                </details>
              )}
              {count > 0 && (
                <div className="project-trust-agent">
                  <Button variant="ghost" size="sm" onClick={askAgent}>{t("project_trust.ask_agent")}</Button>
                  {copied && <p className="settings-status" role="status">{t("project_trust.ask_agent_copied")}</p>}
                </div>
              )}
            </>
          ) : !error && <p className="settings-status">{t("project_trust.loading")}</p>}
          {error && <p className="settings-error" role="alert">{error}</p>}
        </div>
      </div>
      <footer className="new-project-actions pack-dialog-actions">
        <Button size="lg" disabled={busy} onClick={later}>{t("project_trust.later")}</Button>
        <Button variant="default" size="lg" disabled={!summary || busy} onClick={() => void trust()}>
          {busy ? t("project_trust.trusting") : t("project_trust.trust")}
        </Button>
      </footer>
    </AppDialog>
  );
}

/** Id, files and size; WebAssembly, Workers and minified code only when the
 *  files hold them. */
function TrustRow({ motif }: { motif: ProjectTrustMotif }) {
  const { t } = useTranslation();
  const s = motif.summary;
  const facts = s
    ? [
        t("project_trust.files_value", { count: s.files, size: formatBytes(s.bytes) }),
        ...(s.wasm.length ? [t("project_trust.wasm")] : []),
        ...(s.workers.length ? [t("project_trust.workers")] : []),
        ...(s.minified.length ? [t("project_trust.minified")] : []),
      ]
    : [];
  return (
    <li className="portability-row">
      <span className="portability-row-text">
        <span className="portability-row-name">{motif.motif_id}</span>
        {facts.length > 0 && <span className="portability-row-detail">{facts.join(" · ")}</span>}
      </span>
    </li>
  );
}
