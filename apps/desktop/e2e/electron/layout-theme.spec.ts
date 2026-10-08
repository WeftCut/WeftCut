import { test, expect } from '@playwright/test';
import { launchApp, invokeCmd, tmpDir, newProject, rootSummary } from './helpers/driver';
import type { AppSettings } from '../../src/shared/app-settings';

test('settings buttons and form controls scale across every category', async () => {
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  try {
    await page.locator('.startup-settings-toggle').click();
    const tabs = await page.locator('.settings-nav-item').evaluateAll(nodes => nodes.map(node => node.id));
    let checked = 0;
    for (const tab of tabs) {
      await invokeCmd(page, 'app_settings_set', { patch: { layout_theme: '1080p-standard' } });
      await expect(page.locator('html')).toHaveAttribute('data-layout-theme', '1080p-standard');
      await page.locator(`#${tab}`).click();
      const controls = page.locator('.settings-panel button, .settings-panel input, .settings-panel textarea');
      const read = () => controls.evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => ({
        key: [node.tagName, node.getAttribute('aria-label'), node.className, node.textContent?.trim()].join('|'),
        font: parseFloat(getComputedStyle(node).fontSize),
      })));
      const baseline = new Map((await read()).map(node => [node.key, node.font]));
      await invokeCmd(page, 'app_settings_set', { patch: { layout_theme: '4k-wide' } });
      await expect(page.locator('html')).toHaveAttribute('data-layout-theme', '4k-wide');
      for (const node of await read()) {
        const original = baseline.get(node.key);
        if (original === undefined) continue; // Async status rows can arrive between snapshots.
        expect(node.font, `${tab}: ${node.key}`).toBeCloseTo(original * 1.65, 2);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
    await page.locator('#settings-tab-general').click();
    await page.screenshot({ path: '../../.scratch/layout-themes/settings-button-typography.png' });
  } finally { await app.close(); }
});

test('timeline typography follows the theme and ruler labels remain separated', async () => {
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-timeline-type-'), name: 'Timeline type',
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } });
    const { tracks } = await rootSummary<{ tracks: Array<{ id: string; role: string | null }> }>(page);
    const layerId = await invokeCmd<string>(page, 'add_color_layer', {
      trackId: tracks.find(track => track.role === 'b-roll')!.id, tStartUs: 0, durationUs: 10_000_000,
    });
    await invokeCmd(page, 'add_marker', { tUs: 1_000_000, label: '标记文字' });
    const ruler = page.getByTestId('timeline-ruler');
    const track = page.getByTestId('track-header-name').first();
    const marker = page.getByTestId('timeline-marker-label').first();
    const clip = page.locator(`.timeline-layer[data-layer-id="${layerId}"] > span.sticky`);
    for (const [layout_theme, scale] of [['1080p-standard', 1], ['4k-wide', 1.65], ['2k-wide', 1.32]] as const) {
      await invokeCmd(page, 'app_settings_set', { patch: { layout_theme } });
      for (const [el, baseline] of [[ruler, 10], [track, 11], [marker, 9], [clip, 10]] as const) {
        await expect(el).toBeVisible();
        await expect.poll(() => el.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeCloseTo(baseline * scale, 2);
      }
      const labels = await ruler.locator('span').evaluateAll(nodes => nodes.map(node => {
        const r = node.getBoundingClientRect(); return { left: r.left, right: r.right };
      }));
      for (let i = 1; i < labels.length; i++) expect(labels[i]!.left).toBeGreaterThan(labels[i - 1]!.right);
      const fits = await marker.evaluate(node => {
        const label = node.getBoundingClientRect();
        const lane = node.closest('[data-testid="timeline-marker-lane"]')!.getBoundingClientRect();
        return label.top >= lane.top && label.bottom <= lane.bottom;
      });
      expect(fits).toBe(true);
    }
    await page.screenshot({ path: '../../.scratch/layout-themes/timeline-typography.png' });
  } finally { await app.close(); }
});

test('native window minimums follow every theme immediately', async () => {
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  try {
    for (const [layout_theme, width, height] of [
      ['1080p-standard', 960, 640], ['1080p-wide', 1200, 704],
      ['2k-standard', 1152, 768], ['2k-wide', 1440, 845],
      ['4k-standard', 1440, 960], ['4k-wide', 1800, 1056],
      ['1080p-standard', 960, 640],
    ] as const) {
      await invokeCmd(page, 'app_settings_set', { patch: { layout_theme } });
      const state = await app.evaluate(({ BrowserWindow, screen }, requested) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const area = screen.getDisplayMatching(win.getBounds()).workArea;
        return { minimum: win.getMinimumSize(), size: win.getSize(),
          expected: [Math.min(requested[0], area.width), Math.min(requested[1], area.height)] };
      }, [width, height]);
      expect(state.minimum).toEqual(state.expected);
      expect(state.size[0]).toBeGreaterThanOrEqual(state.expected[0]!);
      expect(state.size[1]).toBeGreaterThanOrEqual(state.expected[1]!);
    }
  } finally { await app.close(); }
});

test('panel constraints and chrome scale together when a layout theme changes', async () => {
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-constraints-'), name: 'Constraints',
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } });
    const strip = page.locator('.weft-dock-panel[data-panel-kind="quick-actions"]');
    await expect(strip).toBeVisible();
    const baseline = (await strip.boundingBox())!.width;
    for (const [layout_theme, scale] of [['4k-wide', 1.65], ['2k-wide', 1.32], ['1080p-standard', 1]] as const) {
      await invokeCmd(page, 'app_settings_set', { patch: { layout_theme } });
      await expect(page.locator('html')).toHaveAttribute('data-layout-theme', layout_theme);
      // Dockview's group gap takes half a gap off this edge panel's content.
      await expect.poll(async () => Math.abs((await strip.boundingBox())!.width - baseline * scale)).toBeLessThan(1.5);
    }
  } finally {
    await app.close();
  }
});

test('header search text fits the 4K relaxed theme', async () => {
  const { app, page } = await launchApp({ locale: 'zh-CN' });
  const viewport = await page.context().newCDPSession(page);
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-search-layout-'), name: 'Search layout',
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } });
    await invokeCmd(page, 'app_settings_set', { patch: { layout_theme: '4k-wide' } });
    await expect(page.locator('html')).toHaveAttribute('data-layout-theme', '4k-wide');
    // A theme's native minimum is capped by the display work area. Exercise
    // that constraint on every OS, independent of the runner's monitor size.
    const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio);
    for (const width of [1800, 1400, 1360, 1280, 1024, 960, 1800]) {
      await viewport.send('Emulation.setDeviceMetricsOverride', {
        width, height: 768, mobile: false, deviceScaleFactor,
      });
      for (const [language, text] of [['zh-CN', '搜索'], ['en-US', 'Search']] as const) {
        await invokeCmd(page, 'app_settings_set', { patch: { language } });
        const label = page.locator('.header-search-label');
        await expect(label).toHaveText(text);
        const size = await label.evaluate(el => ({ needed: el.scrollWidth, available: el.clientWidth }));
        expect(size.available, `${width}px ${language}: ${JSON.stringify(size)}`).toBeGreaterThanOrEqual(size.needed);
        const chrome = await page.locator('.app-header').evaluate(el => {
          const left = el.querySelector('.header-left')!.getBoundingClientRect();
          const search = el.querySelector('.header-search')!.getBoundingClientRect();
          const right = el.querySelector('.header-right')!.getBoundingClientRect();
          return { overflow: el.scrollWidth - el.clientWidth,
            leftGap: search.left - left.right, rightGap: right.left - search.right };
        });
        expect(chrome.overflow, `${width}px ${language}`).toBeLessThanOrEqual(1);
        expect(chrome.leftGap).toBeGreaterThanOrEqual(-1);
        expect(chrome.rightGap).toBeGreaterThanOrEqual(0);
        await page.locator('.header-search').click();
        await expect(page.locator('.search-palette-input input')).toBeVisible();
        await page.keyboard.press('Escape');
        if (width === 960 && language === 'en-US') {
          await page.screenshot({ path: '../../.scratch/layout-themes/4k-compact-header-search.png' });
        }
      }
    }
    // Returning to a roomy window restores the full header.
    await expect(page.locator('.app-brand h1')).toBeVisible();
    await expect(page.locator('.header-search-kbd')).toBeVisible();
    await expect(page.locator('.app-header .locale-toggle-label')).toBeVisible();
    await page.screenshot({ path: '../../.scratch/layout-themes/4k-relaxed-header-search.png' });
  } finally {
    await viewport.detach();
    await app.close();
  }
});

test('layout themes resize typography and portal dialogs, fit a small window and survive restart', async () => {
  const userDataDir = tmpDir('weftcut-layout-theme-');
  const first = await launchApp({ locale: 'zh-CN', userDataDir });
  const viewport = await first.page.context().newCDPSession(first.page);
  try {
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 1000));
    await first.page.locator('.startup-settings-toggle').click();
    const dialog = first.page.locator('.settings-panel--nav');
    const chooser = first.page.getByRole('combobox', { name: '布局主题', exact: true });
    const presets = [
      ['1080p-standard', '1080p · 标准', 720, 12],
      ['1080p-wide', '1080p · 宽松', 900, 13.2],
      ['2k-standard', '2K（1440p）· 标准', 864, 14.4],
      ['2k-wide', '2K（1440p）· 宽松', 1080, 15.84],
      ['4k-standard', '4K · 标准', 1080, 18],
      ['4k-wide', '4K · 宽松', 1350, 19.8],
    ] as const;
    for (const [id, label, width, fontSize] of presets) {
      await chooser.click();
      await first.page.getByRole('option', { name: label, exact: true }).click();
      await expect(first.page.locator('html')).toHaveAttribute('data-layout-theme', id);
      await expect(chooser).toHaveCSS('font-size', `${fontSize}px`);
      await expect.poll(async () => Math.round((await dialog.boundingBox())!.width)).toBe(width);
      expect((await invokeCmd<AppSettings>(first.page, 'app_settings_get')).layout_theme).toBe(id);
    }
    // Exercise renderer containment below the native floor as a separate concern.
    // Native move/display events can restore the theme's minimum while a
    // macOS window is being resized. Emulate the renderer viewport so this
    // containment check is independent of the native floor tested above.
    await viewport.send('Emulation.setDeviceMetricsOverride', {
      width: 1000, height: 700, mobile: false,
      deviceScaleFactor: await first.page.evaluate(() => devicePixelRatio),
    });
    await expect.poll(() => first.page.evaluate(() => innerWidth)).toBe(1000);
    await expect.poll(async () => (await dialog.boundingBox())!.width).toBeLessThanOrEqual(1000 - 32);
    const overflow = await dialog.evaluate(el => {
      const content = el.querySelector('.settings-content')!;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        width: innerWidth, height: innerHeight,
        overflowX: content.scrollWidth - content.clientWidth };
    });
    expect(overflow.left).toBeGreaterThanOrEqual(0);
    expect(overflow.top).toBeGreaterThanOrEqual(0);
    expect(overflow.right).toBeLessThanOrEqual(overflow.width);
    expect(overflow.bottom).toBeLessThanOrEqual(overflow.height);
    expect(overflow.overflowX).toBeLessThanOrEqual(1);
    await first.page.screenshot({ path: '../../.scratch/layout-themes/4k-wide-small-window.png' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await first.page.getByRole('button', { name: '新建项目', exact: true }).click();
    const prompt = first.page.locator('.new-project-panel');
    await expect(prompt).toBeVisible();
    await expect.poll(async () => Math.round((await prompt.boundingBox())!.width)).toBe(825);
    const form = await prompt.evaluate(el => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: innerHeight,
        overflowX: el.scrollWidth - el.clientWidth, overflowY: getComputedStyle(el).overflowY };
    });
    expect(form.top).toBeGreaterThanOrEqual(0);
    expect(form.bottom).toBeLessThanOrEqual(form.height);
    expect(form.overflowX).toBeLessThanOrEqual(1);
    expect(form.overflowY).toBe('auto');
    await first.page.screenshot({ path: '../../.scratch/layout-themes/4k-wide-new-project.png' });
  } finally {
    await viewport.detach();
    await first.app.close();
  }
  const restarted = await launchApp({ locale: 'zh-CN', userDataDir });
  try {
    await expect(restarted.page.locator('html')).toHaveAttribute('data-layout-theme', '4k-wide');
    const restored = await restarted.app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      return { minimum: win.getMinimumSize(), expected: [Math.min(1800, area.width), Math.min(1056, area.height)] };
    });
    expect(restored.minimum).toEqual(restored.expected);
    await restarted.page.locator('.startup-settings-toggle').click();
    await expect(restarted.page.getByRole('combobox', { name: '布局主题', exact: true })).toContainText('4K · 宽松');
  } finally {
    await restarted.app.close();
  }
});
