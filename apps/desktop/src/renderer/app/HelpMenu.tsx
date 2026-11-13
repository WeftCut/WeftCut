import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Menu, MenuItem, MenuSeparator } from "../menu/Menu";
import { useNoticedUpdate } from "./updateStatus";
import { AboutDialog } from "./AboutDialog";
import { DiagnosticReport } from "./DiagnosticReport";
import { UpdateDialog } from "./UpdateDialog";

/// The Help menu — the in-app update check (UpdateDialog), issue reporting
/// (diagnostic export + a GitHub draft) and the About box. Self-contained: the dialog open
/// state lives here, so AppMenuBar stays prop-driven chrome. An offered update
/// marks the menu and its Check for Updates row; the bell lists it too.
export function HelpMenu() {
  const { t } = useTranslation();
  const updateMark = useNoticedUpdate() !== null ? t("updates.available") : undefined;
  const [aboutOpen, setAboutOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  return (
    <>
      <Menu label={t("menu.help")} marked={updateMark}>
        <MenuItem
          label={t("help.check_updates")}
          onSelect={() => setUpdatesOpen(true)}
          marked={updateMark}
        />
        <MenuItem
          label={t("help.report_issue")}
          onSelect={() => setReportOpen(true)}
        />
        <MenuSeparator />
        <MenuItem
          label={t("help.about")}
          onSelect={() => setAboutOpen(true)}
        />
      </Menu>
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {updatesOpen && <UpdateDialog onClose={() => setUpdatesOpen(false)} />}
      {reportOpen && <DiagnosticReport onClose={() => setReportOpen(false)} />}
    </>
  );
}
