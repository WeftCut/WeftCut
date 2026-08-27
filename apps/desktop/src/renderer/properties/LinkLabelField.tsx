import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppInput } from "../components/AppInput";
import { tryMutate } from "../errors/tryMutate";
import { linksRename, type LinkSummary } from "../ipc";

/// The inspector's identity line — `kind · track · link` — with the link
/// segment as a click-to-edit field over `links_rename`. Idle, the whole line
/// is ONE text run: the link's label, or its member count when it has none,
/// or "Not linked". Clicking a linked line swaps that segment for an input.
///
/// Enter and blur commit, Escape discards. An empty field CLEARS the label —
/// unlike the layer label, whose patch cannot express null, a link's ordinary
/// state is unlabelled (an A/V pair has no name), so clearing is a real edit
/// and not a revert. A commit that would not change the label is skipped, so
/// re-committing records no history row.
export function LinkLabelField({
  kindLabel,
  trackLabel,
  link,
  onMutated,
}: {
  kindLabel: string;
  trackLabel: string;
  link: LinkSummary | null;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Escape's blur still reaches `onBlur` (focus is handed back to the panel),
  // so the cancel has to be remembered across it or it would commit anyway;
  // a commit flips it too, so the edit settles exactly once per `begin`.
  const cancelledRef = useRef(false);

  const linkText = link
    ? link.label?.trim() ||
      t("property_panel.link_of", { count: link.layer_ids.length })
    : t("property_panel.link_none");

  const begin = () => {
    if (!link) return;
    cancelledRef.current = false;
    setDraft(link.label ?? "");
    setEditing(true);
  };

  const commit = async (): Promise<void> => {
    setEditing(false);
    if (cancelledRef.current || !link) return;
    // Settled: Enter and the blur it may trigger both reach here — the second
    // must not record a second rename.
    cancelledRef.current = true;
    const next = draft.trim() || null;
    if (next === link.label) return;
    if (await tryMutate(() => linksRename(link.id, next), "Rename link")) {
      await onMutated();
    }
  };

  const cancel = () => {
    cancelledRef.current = true;
    setEditing(false);
  };

  if (editing && link) {
    return (
      <p className="prop-identity-meta" data-testid="link-label-field">
        {`${kindLabel} · ${trackLabel} · `}
        <AppInput
          autoFocus
          className="inline-block w-40 align-baseline"
          value={draft}
          ariaLabel={t("property_panel.link_rename")}
          onValueChange={setDraft}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          onCancel={cancel}
        />
      </p>
    );
  }
  return (
    <p
      className={`prop-identity-meta${link ? " cursor-text" : ""}`}
      data-testid="link-label-field"
      title={link ? t("property_panel.link_rename") : undefined}
      onClick={link ? begin : undefined}
    >
      {`${kindLabel} · ${trackLabel} · ${linkText}`}
    </p>
  );
}
