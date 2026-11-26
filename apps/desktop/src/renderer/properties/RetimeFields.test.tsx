// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../i18n';
import { RetimeFields } from './RetimeFields';
import { useProjectStore } from '../state/projectStore';
import { useSelectionStore } from '../state/selectionStore';
import { setLinkOverride } from '../state/linkOverrideStore';
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
function mount(clips: LayerSummary[], sameTrack = false, linked: string[] = []) {
  const tracks = (sameTrack ? [clips] : clips.map(c => [c])).map((layers, i) => ({
    id: `track-${i}`, label: null, enabled: true, locked: false, layers,
  })) as TrackSummary[];
  const links = linked.length ? [{ id: 'link', layer_ids: linked }] : [];
  useProjectStore.getState().apply(summaryFixture({ root: { tracks, links, duration_us: 10_000_000 } }));
  useSelectionStore.setState({ selection: { kind: 'layers', primary: clips[0]!.id, ids: new Set(clips.map(c => c.id)) } });
  render(<RetimeFields layer={clips[0]!} disabled={false} onMutated={vi.fn()} fpsNum={30} fpsDen={1} />);
}
beforeEach(async () => { await i18n.changeLanguage('en-US'); vi.clearAllMocks(); });
afterEach(() => { cleanup(); useProjectStore.getState().apply(null); setLinkOverride(false); });

it('sets pitch on the inspected clip only when the other selected clips are unlinked', async () => {
  mount([clip('voice'), clip('other', 'Audio', false)]);
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  const pitch = screen.getByRole('checkbox', { name: 'Preserve pitch' }) as HTMLInputElement;
  expect(pitch.checked).toBe(true);
  await userEvent.click(pitch);
  await waitFor(() => expect(setPreservePitch).toHaveBeenCalledExactlyOnceWith(['voice'], false));
  expect(retimeLayers).not.toHaveBeenCalled();
});

it('offers no pitch control for a video clip whose selected audio is not linked to it', () => {
  mount([clip('video', 'VideoClip'), clip('voice')]);
  expect(screen.queryByRole('checkbox')).toBeNull();
});

it('retimes and pitches the link partners of the inspected clip, and leaves the rest of the selection', async () => {
  mount([clip('video', 'VideoClip'), clip('voice', 'Audio', false), clip('music')], false, ['video', 'voice']);
  await userEvent.click(screen.getByRole('button', { name: 'Reset to 1×' }));
  await waitFor(() => expect(retimeLayers).toHaveBeenCalledExactlyOnceWith(['video', 'voice'], { kind: 'Rate', value: { num: 1, den: 1 } }));
  await userEvent.click(screen.getByRole('checkbox', { name: 'Preserve pitch' }));
  await waitFor(() => expect(setPreservePitch).toHaveBeenCalledExactlyOnceWith(['voice'], true));
});

it.each([
  ['cannot be retimed', clip('title', 'Text')],
  ['starts elsewhere', clip('voice', 'Audio', true, 1_000_000)],
  ['plays at another rate', { ...clip('voice'), params: { ...clip('voice').params, src_out_us: 4_000_000, time_map: { kind: 'Affine', rate: { num: 2, den: 1 } } } } as LayerSummary],
])('retimes the inspected clip alone when its link partner %s', async (_case, partner) => {
  mount([clip('video', 'VideoClip'), partner], false, ['video', partner.id]);
  expect(screen.queryByRole('checkbox')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Reset to 1×' }));
  await waitFor(() => expect(retimeLayers).toHaveBeenCalledExactlyOnceWith(['video'], { kind: 'Rate', value: { num: 1, den: 1 } }));
});

it('names a locked link partner when it blocks the retime', async () => {
  const voice = { ...clip('voice'), locked: true };
  mount([clip('video', 'VideoClip'), voice], false, ['video', 'voice']);
  await userEvent.click(screen.getByRole('button', { name: 'Reset to 1×' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('voice'));
  expect(retimeLayers).not.toHaveBeenCalled();
});

it('retimes only the inspected clip while the link override is on', async () => {
  setLinkOverride(true);
  mount([clip('video', 'VideoClip'), clip('voice')], false, ['video', 'voice']);
  expect(screen.queryByRole('checkbox')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Reset to 1×' }));
  await waitFor(() => expect(retimeLayers).toHaveBeenCalledExactlyOnceWith(['video'], { kind: 'Rate', value: { num: 1, den: 1 } }));
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
