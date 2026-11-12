/// What the preview shows in place of its picture while the export pipeline
/// holds its decoders: who is using them. A suspended preview draws an empty
/// stage, and black with no word reads as a fault.

import { useTranslation } from "react-i18next";

/// Who the preview yielded to: an export, or an agent's `render_frames`.
export type PreviewSuspendedBy = "export" | "agent";

export function PreviewSuspendedNotice({ by, preparing = false }: { by: PreviewSuspendedBy; preparing?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="preview-suspended" role="status" data-testid="preview-suspended" data-by={by}>
      <span className="preview-spinner" aria-hidden="true" />
      <span className="placeholder">{t(by === "agent" ? "preview.suspended_agent" : preparing ? "preview.suspended_export_preparing" : "preview.suspended_export")}</span>
    </div>
  );
}
