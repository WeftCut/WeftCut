// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../i18n';
import { TextCorrectionDialog } from './TextCorrectionDialog';
import { CaptionPanel } from '../panels/CaptionsPanel';
import { useProjectStore } from '../state/projectStore';
import { setLayerSelection } from '../state/selectionStore';
import { summaryFixture } from '../testing/summaryFixture';
import type { LayerSummary } from '../ipc';

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), correct: vi.fn(), log: vi.fn() }));
vi.mock('../ipc', async original => ({ ...await original<typeof import('../ipc')>(),
  getProjectSettings: mocks.get, setCorrectionScript: mocks.save, correctCaptionText: mocks.correct, logEmit: mocks.log,
}));

let settings: { correction_script: string };
const captionIds = ['caption-1', 'caption-2'];
const close = vi.fn();
const refresh = vi.fn().mockResolvedValue(undefined);
function caption(id: string, start: number): LayerSummary {
  return { id, label: null, kind: 'Text', t_start_us: start, t_end_us: start + 3_000_000, color_hint: '#fff', enabled: true, locked: false, effects: [],
    params: { kind: 'Text', content: '今天介绍自动剪缉功能', font_family: 'sans-serif', font_size_px: 54, weight: 400, italic: false,
      align: 'Center', color: { mode: 'Static', value: { r: 255, g: 255, b: 255, a: 255 } },
      x: { mode: 'Static', value: 960 }, y: { mode: 'Static', value: 900 },
      anchor_x: { mode: 'Static', value: 0.5 }, anchor_y: { mode: 'Static', value: 1 }, scale_linked: true, outline: null, shadow: null,
      opacity: { mode: 'Static', value: 1 }, rotation_deg: { mode: 'Static', value: 0 }, scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 },
      box_w: null, box_h: null, valign: 'Top', line_height: 0, letter_spacing: 0 } };
}
beforeEach(async () => {
  vi.clearAllMocks();
  settings = { correction_script: '今天介绍自动剪辑功能。' };
  useProjectStore.getState().apply(summaryFixture({ root: { tracks: [{ id: 'captions', kind: 'Text', label: null, enabled: true, locked: false, muted: false, solo: false, role: 'caption', transient: false, layers: captionIds.map((id, i) => caption(id, i * 4_000_000)) }] } }));
  setLayerSelection(null, []);
  mocks.get.mockImplementation(async () => settings);
  mocks.save.mockImplementation(async (_id: string, text: string) => { settings.correction_script = text; });
  mocks.correct.mockResolvedValue({ changed: 1 });
  mocks.log.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); setLayerSelection(null, []); useProjectStore.getState().apply(null); });
async function open() {
  render(<TextCorrectionDialog onClose={close} onMutated={refresh} />);
  await waitFor(() => expect((screen.getByLabelText('Reference text') as HTMLTextAreaElement).value).toBe('今天介绍自动剪辑功能。'));
}

describe('text correction dialog', () => {
  it('opens from the captions panel without requiring a new transcription', async () => {
    render(<CaptionPanel onMutated={refresh} onActivateCue={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Text correction' }));
    expect(await screen.findByRole('dialog', { name: 'Text correction' })).toBeTruthy();
  });
  it('defaults to the selected captions and applies one undoable transaction', async () => {
    setLayerSelection(captionIds[1]!, [captionIds[1]!]);
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Correct 1 selected captions' }));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    const summary = useProjectStore.getState().summary!;
    expect(mocks.correct).toHaveBeenCalledWith(summary.project_id, summary.root_id, [captionIds[1]], {
      script: settings.correction_script, captions: [{ id: captionIds[1], text: '今天介绍自动剪缉功能', t_start_us: 4_000_000, t_end_us: 7_000_000 }],
    });
    expect(mocks.correct).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('defaults to all captions without a selection', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Correct all 2 captions' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(mocks.correct.mock.calls[0]![2]).toBeNull();
  });
  it('retains edits on close and restores them when reopened without changing captions', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Reference text'), { target: { value: '新的文稿\n第二段' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(settings.correction_script).toBe('新的文稿\n第二段');
    expect(mocks.correct).not.toHaveBeenCalled();
    cleanup();
    render(<TextCorrectionDialog onClose={close} onMutated={refresh} />);
    await waitFor(() => expect((screen.getByLabelText('Reference text') as HTMLTextAreaElement).value).toBe('新的文稿\n第二段'));
  });
  it('clears only the reference text and disables correction', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Clear text' }));
    await waitFor(() => expect(settings.correction_script).toBe(''));
    expect((screen.getByRole('button', { name: 'Correct all 2 captions' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.correct).not.toHaveBeenCalled();
  });
  it('waits for a pending save before applying the latest manuscript', async () => {
    await open();
    let finish!: () => void;
    mocks.save.mockImplementationOnce((_id: string, text: string) => new Promise<void>(resolve => { finish = () => { settings.correction_script = text; resolve(); }; }));
    fireEvent.change(screen.getByLabelText('Reference text'), { target: { value: '今天介绍自动剪辑功能！' } });
    fireEvent.click(screen.getByRole('button', { name: 'Correct all 2 captions' }));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.correct).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(settings.correction_script).toBe('今天介绍自动剪辑功能！');
    expect(mocks.correct.mock.calls[0]![3].script).toBe('今天介绍自动剪辑功能！');
  });
  it('keeps failed saves visible and does not apply unsaved text', async () => {
    await open();
    mocks.save.mockRejectedValueOnce(new Error('save failed'));
    fireEvent.change(screen.getByLabelText('Reference text'), { target: { value: '新的文稿' } });
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Correct all 2 captions' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('save failed'));
    expect(mocks.correct).not.toHaveBeenCalled();
  });
});
