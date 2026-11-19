// What the app says about a project Motif that cannot render, in the user's
// language. Main reports the status, and for an invalid package the package
// error, which is shown as written under the localized lead: it names files
// and manifest fields.
import { useTranslation } from "react-i18next";
import type { MotifStatus } from "../../shared/motifs/projectMotifs";

interface MotifProblemFacts {
  id: string;
  status: Exclude<MotifStatus, "ok">;
  diagnostic?: string | undefined;
}

/** The lead, and under it an invalid package's error. */
export function MotifProblem({ id, status, diagnostic }: MotifProblemFacts) {
  const { t } = useTranslation();
  return (
    <p className="settings-error">
      {t(`motif_picker.problem.${status}`, { id })}
      {status === "invalid" && diagnostic && <span className="motif-problem-detail">{diagnostic}</span>}
    </p>
  );
}
