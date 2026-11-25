import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppDialog } from "../components/AppDialog";
import { openExternal, RELEASES_URL } from "../app/links";
import { Button } from "@/components/ui/button";
import { setAppSettings, useAppSettingsLoaded, useAppSettingsStore } from "../settings/appSettingsStore";
import { launchReleaseNotes, parseReleaseNotes, type Block, type Inline, type ListItem } from "./releaseNotes";

interface ReleaseNotesDialogProps {
  version: string;
  markdown: string;
  onClose: () => void;
}

/// One version's short notes, with a way to the full release page. The notes
/// are English in every UI language.
export function ReleaseNotesDialog({ version, markdown, onClose }: ReleaseNotesDialogProps) {
  const { t, i18n } = useTranslation();
  const blocks = useMemo(() => parseReleaseNotes(markdown), [markdown]);
  return (
    <AppDialog
      title={t("help.release_notes_title", { version })}
      onClose={onClose}
      dismissOnPointerOutside={false}
      panelClassName="settings-panel release-notes-dialog"
    >
      <div className="settings-body">
        <div className="settings-card release-notes">
          {!i18n.language.startsWith("en") && (
            <p className="settings-blurb">{t("help.release_notes_language")}</p>
          )}
          {blocks.map((block, i) => <NotesBlock key={i} block={block} />)}
        </div>
      </div>
      <footer className="release-notes-footer">
        <Button variant="ghost" size="lg" className="mr-auto"
          onClick={() => openExternal(`${RELEASES_URL}/tag/v${version}`)}>
          {t("help.release_notes_full")}
        </Button>
        <Button variant="default" size="lg" onClick={onClose} autoFocus>
          {t("help.release_notes_close")}
        </Button>
      </footer>
    </AppDialog>
  );
}

/// Opens the running version's notes once after an update; closing them in
/// any way records their version so the next launch stays quiet. Help → What's
/// New… reopens them. Dev and E2E builds never open it on their own.
export function LaunchReleaseNotes() {
  const loaded = useAppSettingsLoaded();
  const seen = useAppSettingsStore((s) => s.settings.release_notes_seen_version);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (import.meta.env.DEV || import.meta.env.VITE_WEFTCUT_E2E === "1") return;
    let alive = true;
    window.api.app.versions()
      .then((v) => { if (alive) setAppVersion(v.app); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!loaded || appVersion === null || closed) return null;
  const notes = launchReleaseNotes(appVersion, seen);
  if (notes === null) return null;
  return (
    <ReleaseNotesDialog
      version={notes.version}
      markdown={notes.markdown}
      onClose={() => {
        setClosed(true);
        void setAppSettings({ release_notes_seen_version: notes.version })
          .catch((error) => console.warn("[release-notes] seen", error));
      }}
    />
  );
}

function NotesBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading": return <h3><Inlines parts={block.inlines} /></h3>;
    case "paragraph": return <p><Inlines parts={block.inlines} /></p>;
    case "list": return <NotesList items={block.items} />;
  }
}

function NotesList({ items }: { items: ListItem[] }) {
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>
          <Inlines parts={item.inlines} />
          {item.children.length > 0 && <NotesList items={item.children} />}
        </li>
      ))}
    </ul>
  );
}

function Inlines({ parts }: { parts: Inline[] }) {
  return parts.map((part, i) => {
    switch (part.kind) {
      case "text": return part.text;
      case "strong": return <strong key={i}>{part.text}</strong>;
      case "em": return <em key={i}>{part.text}</em>;
      case "code": return <code key={i}>{part.text}</code>;
    }
  });
}
