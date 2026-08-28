import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import { groupDisplayName } from "../lib/layerName";
import {
  leaveToCrumb,
  useCrumbs,
} from "../state/compositionScopeStore";
import { useGroupOrdinals, useProjectStore } from "../state/projectStore";

/// Where in the project the timeline is looking: `‹project› › Group A › Group B`,
/// every crumb a button that leaves back to it.
///
/// Renders NOTHING at the root, which is the whole reason it can sit in normal
/// flow above the timeline's scroll container rather than floating over it: a
/// project with no Groups has no extra row, so the layout is exactly what it was
/// before Groups existed, and the row's appearance is itself the signal that you
/// went somewhere.
///
/// The path comes from the scope store's crumbs — the Groups actually entered
/// through — not from a search of the project, so a composition placed twice
/// reads as the route the user walked. `openComposition` reconstructs a path from
/// the root for the by-id entries (a search hit, the e2e hook), so the row is
/// never blank while a Group is open.
///
/// Three atomic subscriptions rather than one composite selector
/// (`feedback_zustand_composite_selector`): the crumb array's reference is stable
/// between switches, the name is a string, and the ordinals are one Map per
/// summary.
export function CompositionBreadcrumb() {
  const { t } = useTranslation();
  const crumbs = useCrumbs();
  const projectName = useProjectStore((s) => s.summary?.name ?? "");
  const ordinals = useGroupOrdinals();
  const compositions = useProjectStore((s) => s.summary?.compositions);
  if (crumbs.length === 0) return null;

  const rootLabel = projectName.trim() || t("timeline.breadcrumb");
  const crumbLabel = (compositionId: string): string =>
    groupDisplayName(
      compositionId,
      compositions?.[compositionId]?.label ?? null,
      ordinals,
      t,
    );

  return (
    <nav
      data-testid="timeline-breadcrumb"
      aria-label={t("timeline.breadcrumb")}
      className="flex min-h-6 shrink-0 items-center gap-1 overflow-x-auto border-b border-border-soft bg-card px-2 py-0.5 text-[11px] leading-none text-muted-foreground scrollbar-hidden"
    >
      <Crumb
        index={-1}
        label={rootLabel}
        isOpen={false}
        title={t("timeline.breadcrumb_leave", { label: rootLabel })}
      />
      {crumbs.map((crumb, index) => {
        const label = crumbLabel(crumb.compositionId);
        return (
          <Fragment key={`${crumb.compositionId}-${index}`}>
            <span aria-hidden="true" className="opacity-50">
              ›
            </span>
            <Crumb
              index={index}
              label={label}
              // The last crumb IS the open composition. Still a button — leaving
              // to where you already are is the scope store's own no-op — but
              // marked current so the row says which end of the path you are at
              // without relying on position alone.
              isOpen={index === crumbs.length - 1}
              title={t("timeline.breadcrumb_leave", { label })}
            />
          </Fragment>
        );
      })}
    </nav>
  );
}

function Crumb({
  index,
  label,
  isOpen,
  title,
}: {
  /// The crumb's position in the path; `-1` is the root, which `leaveToCrumb`
  /// reads as "all the way back".
  index: number;
  label: string;
  isOpen: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      data-testid="timeline-crumb"
      data-crumb-index={index}
      aria-current={isOpen ? "page" : undefined}
      className={`max-w-40 shrink-0 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap rounded-sm px-1 py-0.5 hover:bg-secondary hover:text-foreground ${
        isOpen ? "font-semibold text-foreground" : ""
      }`}
      title={title}
      onClick={() => leaveToCrumb(index)}
    >
      {label}
    </button>
  );
}
