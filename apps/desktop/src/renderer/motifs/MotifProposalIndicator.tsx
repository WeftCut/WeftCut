// apps/desktop/src/renderer/motifs/MotifProposalIndicator.tsx
//
// Status-area note while an agent's Motif publication waits for the user's
// approval. Low-key like the renderer-limit note: a label with a tooltip,
// nothing over the canvas, nothing at all when no proposal is pending. A
// click opens the Motifs panel, where the proposal's card is.
import { useTranslation } from "react-i18next";
import { getCommand } from "../commands/registry";
import { useMotifProposals } from "./MotifProposalCard";

export function MotifProposalIndicator() {
  const { t } = useTranslation();
  const count = useMotifProposals()?.length ?? 0;
  if (count === 0) return null;
  const hint = t("motif_proposal.notice_hint");
  return (
    <button
      type="button"
      className="motif-proposal-status"
      title={hint}
      aria-label={`${count === 1 ? t("motif_proposal.notice") : t("motif_proposal.notice_many", { count })}. ${hint}`}
      onClick={() => void getCommand("openMotifPicker")?.run()}
    >
      {count === 1 ? t("motif_proposal.notice") : t("motif_proposal.notice_many", { count })}
    </button>
  );
}
