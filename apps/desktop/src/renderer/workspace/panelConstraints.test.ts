import { afterEach, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { applyLayoutTheme } from '../settings/layoutTheme';
import { wirePanelConstraints } from './panelConstraints';
import { panelMinimum, stripThickness } from './panelRegistry';

afterEach(() => applyLayoutTheme('1080p-standard'));

it('updates group floors on scale, restore and window resize without a relayout loop', () => {
  let layout: () => void = () => {};
  const setConstraints = vi.fn(() => layout());
  const group = { panels: [{ id: 'media' }, { id: 'preview' }], api: { setConstraints } };
  const api = { width: 3000, height: 1800, groups: [group],
    onDidLayoutChange: (listener: () => void) => { layout = listener; return { dispose: () => { layout = () => {}; } }; } };
  const stop = wirePanelConstraints(api as unknown as DockviewApi);
  try {
    applyLayoutTheme('4k-wide');
    expect(setConstraints).toHaveBeenLastCalledWith({ minimumWidth: 528, minimumHeight: 297 });
    expect(setConstraints).toHaveBeenCalledTimes(1);
    expect(panelMinimum('media')).toEqual({ minimumWidth: 396, minimumHeight: 264 });
    expect(stripThickness()).toBe(73);
    // A restored tree has fresh group objects, even at the same scale.
    api.groups = [{ ...group }];
    layout();
    expect(setConstraints).toHaveBeenCalledTimes(2);
    api.width = 1000;
    api.height = 720;
    layout();
    expect(setConstraints).toHaveBeenLastCalledWith({ minimumWidth: 320, minimumHeight: 180 });
    api.width = 3000;
    api.height = 1800;
    layout();
    expect(setConstraints).toHaveBeenLastCalledWith({ minimumWidth: 528, minimumHeight: 297 });
    applyLayoutTheme('1080p-standard');
    expect(setConstraints).toHaveBeenLastCalledWith({ minimumWidth: 320, minimumHeight: 180 });
    expect(stripThickness()).toBe(44);
    const count = setConstraints.mock.calls.length;
    layout();
    expect(setConstraints).toHaveBeenCalledTimes(count);
  } finally { stop(); }
});
