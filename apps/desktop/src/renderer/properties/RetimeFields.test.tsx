// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../i18n';
import { RetimeFields } from './RetimeFields';
import { useProjectStore } from '../state/projectStore';
import { useSelectionStore } from '../state/selectionStore';
import { summaryFixture } from '../testing/summaryFixture';
import type { LayerSummary, TrackSummary } from '../ipc';

const { retimeLayers, setPreservePitch } = vi.hoisted(() => ({
  retimeLayers: vi.fn(async (..._args: unknown[]) => ({})),
  setPreservePitch: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('../ipc', async (original) => ({
  ...await original<typeof import('../ipc')>(), retimeLayers, setPreservePitch,
}));

function clip(id: string, kind = 'Audio', preserve_pitch = true, start = 0): LayerSummary {
  return { id, label: id, kind, enabled: true, locked: false, effects: [], color_hint: '',
    t_start_us: start, t_end_us: start + 2_000_000,
    params: { kind, src_in_us: 0, src_out_us: 2_000_000, preserve_pitch },
  } as unknown as LayerSummary;
}
function mount(clips: LayerSummary[], sameTrack = false) {
  const tracks = (sameTrack ? [clips] : clips.map(c => [c])).map((layers, i) => ({
    id: `track-${i}`, label: null, enabled: true, locked: false, layers,
  })) as TrackSummary[];
  useProjectStore.getState().apply(summaryFixture({ root: { tracks, duration_us: 10_000_000 } }));
  useSelectionStore.setState({ selection: { kind: 'layers', primary: clips[0]!.id, ids: new Set(clips.map(c => c.id)) } });
  render(<RetimeFields layer={clips[0]!} disabled={false} onMutated={vi.fn()} fpsNum={30} fpsDen={1} />);
}
beforeEach(async () => { await i18n.changeLanguage('en-US'); vi.clearAllMocks(); });
afterEach(() => { cleanup(); useProjectStore.getState().apply(null); });

it('shows mixed pitch and applies only to selected Audio/Group clips', async () => {
  mount([clip('voice'), clip('group', 'CompositionRef', false), clip('video', 'VideoClip')]);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Apply to all 3 selected clips' }));
  const pitch = screen.getByRole('checkbox', { name: 'Preserve pitch' }) as HTMLInputElement;
  expect(pitch.indeterminate).toBe(true);
  expect(pitch.getAttribute('aria-checked')).toBe('mixed');
  await userEvent.click(pitch);
  await waitFor(() => expect(setPreservePitch).toHaveBeenCalledWith(['voice', 'group'], true));
  expect(retimeLayers).not.toHaveBeenCalled();
});

it('offers batch pitch when the primary clip is video, and states its target scope', async () => {
  mount([clip('video', 'VideoClip'), clip('voice')]);
  expect(screen.queryByRole('checkbox', { name: 'Preserve pitch' })).toBeNull();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Apply to all 2 selected clips' }));
  const pitch = screen.getByRole('checkbox', { name: 'Preserve pitch' });
  expect(screen.getByText('Applies to the 1 selected audio or Group clip.')).toBeTruthy();
  await userEvent.click(pitch);
  await waitFor(() => expect(setPreservePitch).toHaveBeenCalledWith(['voice'], false));
});

it('keeps pitch local until batch editing is explicitly enabled', async () => {
  mount([clip('voice'), clip('other', 'Audio', false)]);
  const pitch = screen.getByRole('checkbox', { name: 'Preserve pitch' }) as HTMLInputElement;
  expect(pitch.indeterminate).toBe(false);
  await userEvent.click(pitch);
  await waitFor(() => expect(setPreservePitch).toHaveBeenCalledWith(['voice'], false));
});

it('names the blocking clip and shows usable limits before and after a refused commit', async () => {
  mount([clip('Interview', 'VideoClip'), clip('B-roll', 'VideoClip', true, 3_000_000)], true);
  await userEvent.click(screen.getByRole('button', { name: 'Speed' }));
  const input = screen.getByRole('textbox', { name: 'Speed' });
  await userEvent.clear(input); await userEvent.type(input, '0.5');
  const check = () => {
    const message = screen.getByRole('alert').textContent;
    expect(message).toContain('Interview'); expect(message).toContain('B-roll');
    expect(message).toContain('00:00:03:00'); expect(message).toContain('0.66666667');
  };
  check();
  await userEvent.keyboard('{Enter}');
  check(); expect(retimeLayers).not.toHaveBeenCalled();
});

it('retains detailed actor refusals when the local preview was accepted', async () => {
  mount([clip('Interview', 'VideoClip'), clip('B-roll', 'VideoClip')]);
  retimeLayers.mockRejectedValueOnce(new Error(JSON.stringify({ error: 'RetimeRejected', reason: {
    kind: 'Collision', layer_id: 'Interview', blocking_layer_id: 'B-roll',
    maximum_duration_us: 1_000_000, minimum_rate: { num: 2, den: 1 },
  } })));
  await userEvent.click(screen.getByRole('button', { name: 'Speed' }));
  const input = screen.getByRole('textbox', { name: 'Speed' });
  await userEvent.clear(input); await userEvent.type(input, '0.5');
  expect(screen.queryByRole('alert')).toBeNull();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => {
    const message = screen.getByRole('alert').textContent;
    expect(message).toContain('Interview'); expect(message).toContain('B-roll');
    expect(message).toContain('00:00:01:00'); expect(message).toContain('≈2×');
  });
  expect(screen.getByRole('button', { name: 'Speed' }).textContent).toContain('1.00');
});
