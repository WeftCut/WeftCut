// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '../i18n';
import type { MotifSummary } from '../ipc';
const getCover = vi.hoisted(() => vi.fn());
vi.mock('../ipc', () => ({ getMotifCover: getCover }));
import { MotifCard } from './MotifCard';

const motif: MotifSummary = { id: 'badge', name: 'Badge', version: 1, size: [640, 360],
  default_duration_s: 5, props_schema: {}, status: 'installed', content_hash: 'first' };
const card = (entry = motif) => <MotifCard motif={entry} selected={false} fpsNum={60} fpsDen={1}
  onSelect={() => {}} onExport={() => {}} onDelete={() => {}} />;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); getCover.mockReset(); });

describe('Motif card cover lifecycle', () => {
  it('requests no pixels before becoming visible and releases its image on unmount', async () => {
    let enter!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) {
        enter = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe() {}
      disconnect = disconnect;
    });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cover');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    getCover.mockResolvedValue(new Blob(['png']));
    const view = render(card());
    expect(getCover).not.toHaveBeenCalled();
    act(() => enter());
    await screen.findByRole('img');
    expect(getCover).toHaveBeenCalledExactlyOnceWith('badge', 'first');
    expect(disconnect).toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    view.unmount();
    expect(revoke).toHaveBeenCalledWith('blob:cover');
  });

  it('does not retain a late result for a removed card', async () => {
    let finish!: (blob: Blob) => void;
    getCover.mockReturnValue(new Promise<Blob>(resolve => { finish = resolve; }));
    const create = vi.spyOn(URL, 'createObjectURL');
    const view = render(card());
    await waitFor(() => expect(getCover).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => finish(new Blob(['png'])));
    expect(create).not.toHaveBeenCalled();
  });

  it('replaces a changed package cover and keeps failures local to the card', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:first');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    getCover.mockResolvedValueOnce(new Blob(['png'])).mockRejectedValueOnce(new Error('unavailable'));
    const view = render(card());
    await screen.findByRole('img');
    view.rerender(card({ ...motif, content_hash: 'second' }));
    await screen.findByText('Cover unavailable');
    expect(screen.queryByRole('img')).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:first');
    expect(getCover).toHaveBeenLastCalledWith('badge', 'second');
    expect(screen.getByRole('button', { name: 'Export Motif ZIP' })).toBeTruthy();
  });
});
