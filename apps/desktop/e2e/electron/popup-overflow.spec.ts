import { test, expect, type ElectronApplication, type Locator } from '@playwright/test';
import { launchApp, newProject, tmpDir, invokeCmd } from './helpers/driver';

async function resize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setMinimumSize(0, 0);
    win.setContentSize(size.width, size.height);
  }, { width, height });
}

async function expectContained(popup: Locator) {
  await expect(popup).toBeVisible();
  // Positioner rounds to device pixels; scaled themes can land a fraction of
  // a CSS pixel past the calculated edge.
  await expect.poll(() => popup.evaluate(node => {
    const r = node.getBoundingClientRect();
    return Math.max(-r.top, -r.left, r.bottom - innerHeight * 0.9, r.right - innerWidth);
  })).toBeLessThanOrEqual(1);
}

async function expectOutsideTrigger(popup: Locator, trigger: Locator) {
  await expect.poll(async () => {
    const menu = await popup.boundingBox();
    const button = await trigger.boundingBox();
    if (!menu || !button) return false;
    return menu.y >= button.y + button.height - 1 || menu.y + menu.height <= button.y + 1;
  }).toBe(true);
}

test('long menus fit the window, scroll to the last item and resize while open', async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-menu-overflow-'), name: 'Menu overflow',
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 } });
    await invokeCmd(page, 'app_settings_set', { patch: { layout_theme: '4k-wide' } });
    await resize(app, 1000, 640);
    const trigger = page.getByRole('menuitem', { name: 'View', exact: true });
    await trigger.click();
    const popup = page.getByRole('menu');
    await expectOutsideTrigger(popup, trigger);
    await expectContained(popup);
    expect(await popup.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await page.keyboard.press('End');
    const last = popup.getByRole('menuitem').last();
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport({ ratio: 0.99 });
    expect(await popup.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await resize(app, 1000, 480);
    await expectOutsideTrigger(popup, trigger);
    await expectContained(popup);
    await page.keyboard.press('Home');
    await expect(popup.getByRole('menuitem').first()).toBeFocused();
    // Theme scaling produces fractional row edges; allow subpixel rounding.
    await expect(popup.getByRole('menuitem').first()).toBeInViewport({ ratio: 0.99 });
    const beforeWheel = await popup.evaluate(node => node.scrollTop);
    await popup.hover({ position: { x: 30, y: 30 } });
    await page.mouse.wheel(0, 300);
    await expect.poll(() => popup.evaluate(node => node.scrollTop)).toBeGreaterThan(beforeWheel);
    // A scroll container must not clip the portaled submenu or disrupt its
    // keyboard navigation after the parent has scrolled.
    const submenuTrigger = popup.locator('.app-submenu-trigger');
    await submenuTrigger.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu')).toHaveCount(2);
    const submenu = page.getByRole('menu').last();
    await expectContained(submenu);
    await page.keyboard.press('End');
    await expect(submenu.getByRole('menuitem').last()).toBeFocused();
    await expect(submenu.getByRole('menuitem').last()).toBeInViewport({ ratio: 0.99 });
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('menu')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
  } finally { await app.close(); }
});

test('form dropdowns constrain long option lists and keep keyboard selection usable', async () => {
  const { app, page } = await launchApp();
  try {
    await page.locator('.startup-settings-toggle').click();
    await invokeCmd(page, 'app_settings_set', { patch: { layout_theme: '4k-wide' } });
    await resize(app, 1000, 300);
    const select = page.getByRole('combobox', { name: 'Layout theme', exact: true });
    await select.click();
    const popup = page.getByRole('listbox');
    await expectOutsideTrigger(popup, select);
    await expectContained(popup);
    expect(await popup.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    const last = page.getByRole('option').last();
    await expect(last).toBeInViewport({ ratio: 0.99 });
    await page.keyboard.press('Enter');
    await expect(popup).toHaveCount(0);
    await expect(select).toBeFocused();
    // FontSelect has its own preferred size; it still honors the same bounds.
    const fontTrigger = page.getByRole('combobox', { name: 'Default text font', exact: true });
    await fontTrigger.click();
    await expectOutsideTrigger(popup, fontTrigger);
    await expectContained(popup);
    await page.keyboard.press('End');
    await expect(page.getByRole('option').last()).toBeInViewport({ ratio: 0.99 });
    await page.keyboard.press('Escape');
  } finally { await app.close(); }
});
