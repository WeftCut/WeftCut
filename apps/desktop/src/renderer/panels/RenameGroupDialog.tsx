import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { Button } from "../components/ui/button";
import { groupsRename } from "../ipc";
import { tryMutate } from "../errors/tryMutate";

/// Name a Group's composition. Writes `groups_rename`, not the clip's label: a
/// Group has both, and this surface names the composition every instance of it
/// shows.
export function RenameGroupDialog({
  compositionId,
  displayName,
  storedLabel,
  onClose,
  onMutated,
}: {
  compositionId: string;
  /// The name the card shows, stored or derived — the field's placeholder.
  displayName: string;
  /// The composition's OWN label, `null` while the name is derived — the field
  /// seeds from this rather than from the displayed name, so opening the dialog
  /// on an unnamed Group offers an empty field with `Group N` as its placeholder
  /// instead of pre-filling a name the user never typed.
  storedLabel: string | null;
  onClose: () => void;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(storedLabel ?? "");

  const commit = async () => {
    const next = name.trim();
    // Blank clears the name back to the derived one; unchanged is an actor-level
    // no-op with no history row, so there is nothing to send.
    if (next !== (storedLabel ?? "")) {
      const ok = await tryMutate(
        () => groupsRename(compositionId, next || null),
        "groups_rename",
      );
      if (!ok) return;
      await onMutated();
    }
    onClose();
  };

  return (
    <AppDialog
      title={t("media_pool.groups_rename_title")}
      onClose={onClose}
      panelClassName="settings-panel"
    >
      <div className="settings-body">
        <div className="settings-card">
          <AppInput
            autoFocus
            value={name}
            placeholder={displayName}
            ariaLabel={t("media_pool.groups_rename_title")}
            onValueChange={setName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              }
            }}
          />
          <div className="export-actions">
            <Button size="lg" onClick={onClose}>
              {t("media_pool.remove_cancel")}
            </Button>
            <Button variant="default" size="lg" onClick={() => void commit()}>
              {t("media_pool.groups_rename_confirm")}
            </Button>
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
