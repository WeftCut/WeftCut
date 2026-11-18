// The user's own "Save to library" of a project Motif (spec § Library,
// "Guards"): a Motif the library lacks is saved at once as a new one; one that
// would replace a library Motif first shows a confirm card with the change
// (the proposal card's diff), saying no existing project changes, with "Save
// as a new Motif" beside "Replace". The default target follows the lineage;
// a built-in is never replaced, so a copy of one saves as new.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { refusalText } from "../errors/tryMutate";
import { planSaveToLibrary, saveToLibrary, type MotifPublishPlan } from "../ipc";
import { MotifDiffLines } from "./MotifProposalCard";

interface Pending { motifId: string; plan: MotifPublishPlan & { replaces: { id: string; version: number } } }

/** `start(motifId)` saves or asks; `dialog` is the confirm card to render
 *  while one waits. `start` rejects with the refusal when nothing was saved
 *  without asking; the card shows its own. `libraryName` names a library id. */
export function useSaveToLibrary(libraryName: (id: string) => string | undefined): {
  start: (motifId: string) => Promise<void>;
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (motifId: string) => {
    const plan = await planSaveToLibrary(motifId);
    if (plan.replaces) {
      setError(null);
      setPending({ motifId, plan: { ...plan, replaces: plan.replaces } });
    } else {
      await saveToLibrary(motifId, plan.revision);
    }
  };

  const decide = async (replace: boolean) => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await saveToLibrary(pending.motifId, pending.plan.revision, replace ? pending.plan.replaces : undefined);
      setPending(null);
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  const target = pending?.plan.replaces;
  const targetName = target ? libraryName(target.id) ?? target.id : "";
  const dialog = pending && target ? (
    <AppDialog
      title={t("motif_picker.save_confirm_title", { name: targetName })}
      panelClassName="settings-panel motif-save-dialog"
      onClose={busy ? undefined : () => setPending(null)}
    >
      <div className="settings-body">
        <div className="settings-card">
          <p className="settings-blurb">
            {t("motif_picker.save_confirm_body", { name: targetName, to: target.version + 1 })}
          </p>
          <MotifDiffLines diff={pending.plan.diff} />
          {error && <p className="settings-error" role="alert">{error}</p>}
          <div className="export-actions">
            <Button size="lg" disabled={busy} onClick={() => setPending(null)}>
              {t("motif_picker.cancel")}
            </Button>
            <Button size="lg" disabled={busy} onClick={() => void decide(false)}>
              {t("motif_picker.save_as_new")}
            </Button>
            <Button variant="default" size="lg" disabled={busy} onClick={() => void decide(true)}>
              {busy ? t("motif_picker.saving") : t("motif_picker.save_replace")}
            </Button>
          </div>
        </div>
      </div>
    </AppDialog>
  ) : null;

  return { start, dialog };
}
