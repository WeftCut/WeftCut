import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { dockPanel, invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver';

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 };
const SCRIPT = '今天介绍自动剪辑功能。它可以节省时间。';
async function openCaptions(page: import('@playwright/test').Page) {
  await page.locator('.menu-trigger').nth(2).click();
  await page.locator('.app-menu-item').filter({ hasText: /^Caption$/ }).click();
  const panel = dockPanel(page, 'caption');
  await expect(panel).toHaveCount(1);
  return panel;
}

test('text correction supports imported captions, selected/all scope, undo and saved manuscripts', async ({}, info) => {
  const { app, page } = await launchApp();
  try {
    const parent = tmpDir('weftcut-correction-');
    await newProject(page, { parentFolder: parent, name: 'correction', canvas: CANVAS });
    const srt = path.join(parent, 'captions.srt');
    fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:03,000\n今天介绍自动剪缉功能\n\n2\n00:00:04,000 --> 00:00:07,000\n今天介绍自动剪缉功能\n');
    await invokeCmd(page, 'import_media', { path: srt });
    const panel = await openCaptions(page);
    await expect(panel.locator('.caption-row')).toHaveCount(2);
    await panel.screenshot({ path: info.outputPath('captions-panel.png') });
    await panel.getByRole('button', { name: 'Text correction' }).click();
    const dialog = page.getByRole('dialog', { name: 'Text correction' });
    const field = dialog.getByLabel('Reference text');
    await expect(field).toBeEnabled();
    await field.fill(SCRIPT);
    await expect.poll(async () => (await invokeCmd<{ correction_script: string }>(page, 'get_project_settings')).correction_script).toBe(SCRIPT);
    await dialog.screenshot({ path: info.outputPath('text-correction-dialog.png') });
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await panel.locator('.caption-seek').last().click();
    await panel.getByRole('button', { name: 'Text correction' }).click();
    await expect(field).toHaveValue(SCRIPT);
    await dialog.getByRole('button', { name: 'Correct 1 selected captions' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.locator('.caption-text').first()).toHaveValue('今天介绍自动剪缉功能');
    await expect(panel.locator('.caption-text').last()).toHaveValue('今天介绍自动剪辑功能。');
    await invokeCmd(page, 'project_undo');
    await expect(panel.locator('.caption-text').last()).toHaveValue('今天介绍自动剪缉功能');
    expect((await invokeCmd<{ correction_script: string }>(page, 'get_project_settings')).correction_script).toBe(SCRIPT);
    await panel.getByRole('button', { name: 'Text correction' }).click();
    await dialog.getByRole('combobox').selectOption('all');
    await dialog.getByRole('button', { name: 'Correct all 2 captions' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.locator('.caption-text').first()).toHaveValue('今天介绍自动剪辑功能。');
    await invokeCmd(page, 'project_save');
    const workspace = await invokeCmd<string>(page, 'workspace_dir');
    const stored = JSON.parse(fs.readFileSync(path.join(workspace, 'project.json'), 'utf8'));
    expect(stored.settings.correction_script).toBe(SCRIPT);
    await invokeCmd(page, 'project_open', { path: workspace });
    await panel.getByRole('button', { name: 'Text correction' }).click();
    await expect(field).toHaveValue(SCRIPT);
    await dialog.getByRole('button', { name: 'Clear text' }).click();
    await expect(field).toHaveValue('');
    await expect(panel.locator('.caption-row')).toHaveCount(2);
  } finally { await app.close(); }
});

test('word timing survives project reopen and correction resegments once', async () => {
  const { app, page } = await launchApp();
  try {
    await newProject(page, { parentFolder: tmpDir('weftcut-correction-timing-'), name: 'timing', canvas: CANVAS });
    const summary = await invokeCmd<{ project_id: string; root_id: string }>(page, 'project_summary');
    const text = '今天介绍自动剪缉功能它可以节省时间';
    await invokeCmd(page, 'apply_transcripts', { project_id: summary.project_id, composition_id: summary.root_id, transcripts: [{ word_timing: 'exact', segments: [{ text, t_start_us: 0, t_end_us: text.length * 200_000, words: [...text].map((text, i) => ({ text, t_start_us: i * 200_000, t_end_us: (i + 1) * 200_000 })) }] }] });
    await invokeCmd(page, 'project_save');
    const workspace = await invokeCmd<string>(page, 'workspace_dir');
    await invokeCmd(page, 'project_open', { path: workspace });
    const panel = await openCaptions(page);
    await panel.getByRole('button', { name: 'Text correction' }).click();
    const dialog = page.getByRole('dialog', { name: 'Text correction' });
    await expect(dialog.getByLabel('Reference text')).toBeEnabled();
    await dialog.getByLabel('Reference text').fill(SCRIPT);
    await dialog.getByRole('button', { name: 'Correct all 1 captions' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.locator('.caption-row')).toHaveCount(2);
    await expect(panel.locator('.caption-text').first()).toHaveValue('今天介绍自动剪辑功能。');
    await expect(panel.locator('.caption-text').last()).toHaveValue('它可以节省时间。');
    const before = await invokeCmd<{ history: unknown }>(page, 'project_summary');
    const result = await invokeCmd(page, 'correct_caption_text', { project_id: summary.project_id, composition_id: summary.root_id, layer_ids: null });
    expect(result).toEqual({ changed: 0 });
    expect((await invokeCmd<{ history: unknown }>(page, 'project_summary')).history).toEqual(before.history);
  } finally { await app.close(); }
});
