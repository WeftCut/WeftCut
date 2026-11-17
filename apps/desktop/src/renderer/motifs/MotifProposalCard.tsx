// apps/desktop/src/renderer/motifs/MotifProposalCard.tsx
//
// An agent's proposed Motif publication, waiting for the user (ADR 0046:
// "Motif install waits for the user's approval in the app preview"). The
// card shows what approval would publish: the frozen package in the preview
// player with editable props and the change against the library version.
// Approve adds it to the library, as a version of its target or as a new
// Motif; no project changes, as projects hold copies. Reject hands the note
// back to the agent through list_motifs.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AppInput } from "../components/AppInput";
import { listen } from "@/bridge/events";
import {
  approveMotifProposal,
  listMotifProposals,
  MOTIFS_CHANGED_EVENT,
  rejectMotifProposal,
  type MotifDiff,
  type MotifProposal,
  type MotifSummary,
} from "../ipc";
import { refusalText } from "../errors/tryMutate";
import { MotifPropField } from "../properties/MotifPropFields";
import { defaultPropsFor, MotifPreview, useDebounced } from "./MotifPreview";

/// The pending proposals, refreshed on every `motifs:changed` (a proposal,
/// approval or rejection emits one). `null` until the first answer.
export function useMotifProposals(): MotifProposal[] | null {
  const [proposals, setProposals] = useState<MotifProposal[] | null>(null);
  useEffect(() => {
    let alive = true, generation = 0;
    const reload = () => {
      const mine = ++generation;
      listMotifProposals().then(
        (list) => { if (alive && mine === generation) setProposals(list); },
        () => { if (alive && mine === generation) setProposals([]); },
      );
    };
    reload();
    let un: (() => void) | undefined;
    listen(MOTIFS_CHANGED_EVENT, reload).then((u) => { if (alive) un = u; else u(); }, () => {});
    return () => { alive = false; un?.(); };
  }, []);
  return proposals;
}

export function MotifProposalList({ proposals }: { proposals: MotifProposal[] }) {
  const { t } = useTranslation();
  if (proposals.length === 0) return null;
  return (
    <section className="motif-proposals" aria-label={t("motif_proposal.heading_many", { count: proposals.length })}>
      <h3>
        {proposals.length === 1
          ? t("motif_proposal.heading_one")
          : t("motif_proposal.heading_many", { count: proposals.length })}
      </h3>
      {proposals.map((p) => <MotifProposalCard key={p.proposal_id} proposal={p} />)}
    </section>
  );
}

const names = (list: string[], none: string) => (list.length ? list.join(", ") : none);

/// The change a package makes to the library version it replaces: shared by
/// the proposal card and the Save to library confirm. Null is a first
/// publication.
export function MotifDiffLines({ diff }: { diff: MotifDiff | null }) {
  const { t } = useTranslation();
  const none = t("motif_proposal.diff_empty_list");
  const unchanged = diff !== null && [...Object.values(diff.files), ...Object.values(diff.props)].every((l) => l.length === 0);
  return (
    <div className="motif-diff">
      <h4 className="motif-diff-heading">{t("motif_proposal.diff_heading")}</h4>
      {diff === null ? (
        <p className="motif-proposal-detail">{t("motif_proposal.diff_new")}</p>
      ) : unchanged ? (
        <p className="motif-proposal-detail">{t("motif_proposal.diff_none")}</p>
      ) : (
        <>
          <p className="motif-proposal-detail">
            {t("motif_proposal.diff_files", { added: names(diff.files.added, none), removed: names(diff.files.removed, none), changed: names(diff.files.changed, none) })}
          </p>
          <p className="motif-proposal-detail">
            {t("motif_proposal.diff_props", { added: names(diff.props.added, none), removed: names(diff.props.removed, none), changed: names(diff.props.changed, none) })}
          </p>
        </>
      )}
    </div>
  );
}

export function MotifProposalCard({ proposal }: { proposal: MotifProposal }) {
  const { t } = useTranslation();
  // The frozen package previews under its own id, at the proposed revision.
  const motif = useMemo<MotifSummary>(
    () => ({ ...proposal.manifest, id: proposal.preview_id, content_hash: proposal.revision }) as MotifSummary,
    [proposal.manifest, proposal.preview_id, proposal.revision],
  );
  const [props, setProps] = useState<Record<string, unknown>>(() => defaultPropsFor(motif));
  const debounced = useDebounced(props, 300);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = "new_id" in proposal.target
    ? t("motif_proposal.target_new", { id: proposal.target.new_id })
    : t("motif_proposal.target_update", { id: proposal.target.id, from: proposal.target.version, to: proposal.target.version + 1 });

  const decide = async (approve: boolean, asNew = false) => {
    setBusy(true);
    setError(null);
    try {
      if (approve) await approveMotifProposal(proposal.proposal_id, asNew);
      else await rejectMotifProposal(proposal.proposal_id, note.trim() || undefined);
      // motifs:changed reloads the list; this card unmounts with it.
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  const propKeys = Object.keys(motif.props_schema);

  return (
    <article className="motif-proposal-card" aria-label={t("motif_proposal.region", { name: proposal.manifest.name })}>
      <header className="motif-proposal-head">
        <strong>{proposal.manifest.name}</strong>
        <span className="motif-proposal-target">{target}</span>
      </header>
      <MotifPreview motif={motif} props={debounced} maxWidth={320} />
      {propKeys.map((key) => (
        <MotifPropField
          key={key}
          propKey={key}
          spec={motif.props_schema[key]!}
          value={props[key]}
          commit={{ mode: "buffer", onChange: (v) => setProps((prev) => ({ ...prev, [key]: v })) }}
        />
      ))}
      <MotifDiffLines diff={proposal.diff} />
      <p className="motif-proposal-detail">{t("motif_proposal.approval_effect")}</p>
      <label className="motif-proposal-note">
        <span>{t("motif_proposal.note_label")}</span>
        <AppInput
          value={note}
          onValueChange={setNote}
          placeholder={t("motif_proposal.note_placeholder")}
          ariaLabel={t("motif_proposal.note_label")}
        />
      </label>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="motif-proposal-actions">
        <Button size="sm" disabled={busy} onClick={() => void decide(false)}>
          {t("motif_proposal.reject")}
        </Button>
        {"id" in proposal.target && (
          // A replacement may go in as a library Motif of its own instead.
          <Button size="sm" disabled={busy} onClick={() => void decide(true, true)}>
            {t("motif_proposal.approve_as_new")}
          </Button>
        )}
        <Button size="sm" variant="default" disabled={busy} onClick={() => void decide(true)}>
          {busy ? t("motif_proposal.deciding") : t("motif_proposal.approve")}
        </Button>
      </div>
    </article>
  );
}
