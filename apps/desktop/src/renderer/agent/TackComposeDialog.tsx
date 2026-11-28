import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { TACK_BODY_LIMIT } from "../../shared/agent-activity";
import { AppDialog } from "../components/AppDialog";
import { getCommand } from "../commands/registry";
import { formatTimecode } from "../frames";
import { useProjectStore } from "../state/projectStore";
import { useAgentActivity } from "./activityStore";
import { selectTack } from "./reviewFocus";
import { createUserTack } from "./tackActions";
import { closeTackCompose, useTackComposeStore } from "./tackCompose";

/// Focus a tack once the activity snapshot lists it: the create answers
/// before the delta carrying the tack lands, and `selectTack` needs it listed.
function selectWhenListed(id: string): void {
  const listed = () => useAgentActivity.getState().snapshot?.tacks.some((x) => x.id === id) ?? false;
  if (listed()) return selectTack(id);
  const stop = useAgentActivity.subscribe(() => {
    if (!listed()) return;
    stop();
    selectTack(id);
  });
}

/// The user's "new tack" prompt (ADR 0185): what should change at the place
/// `newTackPlace` chose. Rendered by App so the command works with every panel
/// closed. On success the tack is focused in the Tacks tab, where its
/// conversation goes on.
export function TackComposeDialog() {
  const { t } = useTranslation();
  const place = useTackComposeStore((s) => s.place);
  const composition = useProjectStore((s) => (place ? s.summary?.compositions[place.compositionId] ?? null : null));
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (place !== null) {
      setText("");
      setSaving(false);
    }
  }, [place]);

  if (place === null) return null;

  const canConfirm = text.trim() !== "" && !saving;
  const at = composition
    ? formatTimecode(place.tUs, composition.fps_num, composition.fps_den) +
      (place.endTUs === null ? "" : ` – ${formatTimecode(place.endTUs, composition.fps_num, composition.fps_den)}`)
    : "—";

  const submit = async () => {
    if (!canConfirm) return;
    setSaving(true);
    const id = await createUserTack({ composition_id: place.compositionId, t_us: place.tUs, end_t_us: place.endTUs, text });
    if (id === null) {
      // The refusal is on the status bar; keep what the user wrote.
      setSaving(false);
      return;
    }
    closeTackCompose();
    selectWhenListed(id);
    void getCommand("openAgentPanel")?.run();
  };

  return (
    <AppDialog title={t("tacks.compose.title")} onClose={saving ? undefined : closeTackCompose} panelClassName="new-project-panel">
      <p className="text-muted-foreground" data-testid="tack-compose-place">
        {t(place.endTUs === null ? "tacks.compose.at_point" : "tacks.compose.at_range", { time: at })}
      </p>
      <textarea
        className="app-input"
        data-testid="tack-compose-text"
        value={text}
        rows={5}
        maxLength={TACK_BODY_LIMIT}
        placeholder={t("tacks.compose.placeholder")}
        aria-label={t("tacks.compose.title")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canConfirm) {
            e.preventDefault();
            void submit();
          }
        }}
        autoFocus
      />
      <p className="text-muted-foreground">{t("tacks.compose.hint")}</p>
      <footer className="new-project-actions">
        <Button size="lg" disabled={saving} onClick={closeTackCompose}>
          {t("tacks.compose.cancel")}
        </Button>
        <Button variant="default" size="lg" disabled={!canConfirm} onClick={() => void submit()}>
          {t("tacks.compose.confirm")}
        </Button>
      </footer>
    </AppDialog>
  );
}
