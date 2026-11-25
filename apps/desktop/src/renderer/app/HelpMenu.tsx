import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Menu, MenuItem, MenuSeparator } from "../menu/Menu";
import type { AppVersions } from "../../shared/ipc";
import { AboutDialog } from "./AboutDialog";
import { DiagnosticReport } from "./DiagnosticReport";
import { UpdateDialog } from "./UpdateDialog";
import { currentReleaseNotes } from "../releaseNotes/releaseNotes";
import { ReleaseNotesDialog } from "../releaseNotes/ReleaseNotesDialog";

/// The Help menu — the in-app update check (UpdateDialog), issue reporting
/// (diagnostic export + a GitHub draft), this version's release notes and the
/// About box. Self-contained: the dialog open state lives here, so AppMenuBar
/// stays prop-driven chrome.
export function HelpMenu() {
  const { t } = useTranslation();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  // The renderer bundle has no package.json access: the version identity comes
  // from main, once, for About and What's New alike.
  const [versions, setVersions] = useState<AppVersions | null>(null);
  useEffect(() => {
    let alive = true;
    window.api.app.versions()
      .then((next) => { if (alive) setVersions(next); })
      .catch(() => {
        // Version identity is informational; About shows "…" without it.
      });
    return () => { alive = false; };
  }, []);
  const notes = versions === null ? null : currentReleaseNotes(versions.app);
  return (
    <>
      <Menu label={t("menu.help")}>
        <MenuItem
          label={t("help.check_updates")}
          onSelect={() => setUpdatesOpen(true)}
        />
        <MenuItem
          label={t("help.report_issue")}
          onSelect={() => setReportOpen(true)}
        />
        <MenuItem
          label={t("help.whats_new")}
          disabled={notes === null}
          onSelect={() => setNotesOpen(true)}
        />
        <MenuSeparator />
        <MenuItem
          label={t("help.about")}
          onSelect={() => setAboutOpen(true)}
        />
      </Menu>
      {aboutOpen && <AboutDialog versions={versions} onClose={() => setAboutOpen(false)} />}
      {updatesOpen && <UpdateDialog onClose={() => setUpdatesOpen(false)} />}
      {notesOpen && notes !== null && (
        <ReleaseNotesDialog version={notes.version} markdown={notes.markdown} onClose={() => setNotesOpen(false)} />
      )}
      {reportOpen && <DiagnosticReport onClose={() => setReportOpen(false)} />}
    </>
  );
}
