import { Popover } from "@base-ui/react/popover";
import { Grid3x3 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AppIcon } from "../components/AppIcon";
import { AppPopoverPositioner } from "../components/PopupPositioner";
import { usePreviewGrid } from "../settings/appSettingsStore";
import { CanvasSnapSettings, PreviewGridControls, TimelineSnapSettings } from "../settings/SnapSettings";
import type { StripOrientation } from "./QuickActionsPanel";

export function SnappingPopover({ orientation, tabbable, onFocus }: {
  orientation: StripOrientation;
  tabbable: boolean;
  onFocus: () => void;
}) {
  const { t } = useTranslation();
  const grid = usePreviewGrid();
  const [error, setError] = useState("");
  const label = t("quick_actions.snapping_options");

  return (
    <Popover.Root onOpenChange={() => setError("")}>
      <Popover.Trigger
        className="weft-quick-action"
        data-quick-action="snappingOptions"
        data-active={grid.visible || grid.snap}
        aria-label={label}
        title={label}
        tabIndex={tabbable ? 0 : -1}
        onFocus={onFocus}
      >
        <AppIcon icon={Grid3x3} size="heading" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <AppPopoverPositioner
          className="app-popup-positioner"
          side={orientation === "vertical" ? "right" : "top"}
          align="start"
          sideOffset={4}
        >
          <Popover.Popup className="app-menu-list quick-snapping-popup">
            <Popover.Title className="quick-snapping-title">{label}</Popover.Title>
            <section>
              <h3>{t("settings.timeline_heading")}</h3>
              <TimelineSnapSettings compact onError={setError} />
            </section>
            <section>
              <h3>{t("quick_actions.snapping_canvas")}</h3>
              <CanvasSnapSettings compact onError={setError} />
            </section>
            <section>
              <h3>{t("quick_actions.snapping_grid")}</h3>
              <PreviewGridControls onError={setError} />
            </section>
            {error && <p className="settings-error" role="alert">{error}</p>}
          </Popover.Popup>
        </AppPopoverPositioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
