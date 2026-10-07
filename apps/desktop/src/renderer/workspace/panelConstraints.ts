import type { DockviewApi } from 'dockview-react';
import { getUiScale, subscribeUiScale } from '../settings/layoutTheme';
import { PANEL_REGISTRY, parsePanelId } from './panelRegistry';

/** Constraints belong to groups in Dockview, not panel APIs. Resolve them
 * again after a theme switch, resize, tab move or restore; never restore stale
 * screen-pixel constraints from a saved layout. The strip owns its own cap. */
export function wirePanelConstraints(api: DockviewApi): () => void {
  const applied = new WeakMap<object, string>();
  let wasScaled = false;
  const refresh = () => {
    const scale = getUiScale();
    if (scale === 1 && !wasScaled) return; // Baseline panels already declare these floors.
    wasScaled = true;
    // At small window sizes, yield floors proportionally rather than forcing
    // the grid beyond the viewport. Content continues to scroll in its panel.
    const widthScale = Math.min(scale, Math.max(1, api.width / 1000));
    const heightScale = Math.min(scale, Math.max(1, api.height / 720));
    for (const group of api.groups) {
      const kinds = group.panels.flatMap(panel => {
        const parsed = parsePanelId(panel.id);
        return parsed ? [parsed.kind] : [];
      });
      if (!kinds.length || kinds.length === 1 && kinds[0] === 'quick-actions') continue;
      const minimumWidth = Math.round(Math.max(...kinds.map(kind => PANEL_REGISTRY[kind].minimumWidth)) * widthScale);
      const minimumHeight = Math.round(Math.max(...kinds.map(kind => PANEL_REGISTRY[kind].minimumHeight)) * heightScale);
      const key = `${minimumWidth}:${minimumHeight}`;
      if (applied.get(group) === key) continue;
      // Cache before writing: setConstraints synchronously triggers layout.
      applied.set(group, key);
      group.api.setConstraints({ minimumWidth, minimumHeight });
    }
  };
  const layout = api.onDidLayoutChange(refresh);
  const unsubscribe = subscribeUiScale(refresh);
  refresh();
  return () => { layout.dispose(); unsubscribe(); };
}
