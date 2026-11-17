// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '../i18n';
import type { LibraryMotifRow, ProjectMotifRow } from '../ipc';
const getCover = vi.hoisted(() => vi.fn());
vi.mock('../ipc', () => ({ getMotifCover: getCover }));
import { MotifCard } from './MotifCard';

const motif = { id: 'badge', name: 'Badge', version: 1, size: [640, 360] as [number, number],
  default_duration_s: 5, props_schema: {}, content_hash: 'first' };
const libraryRow = (content_hash = 'first'): LibraryMotifRow => ({ group: 'library', id: 'badge', status: 'installed', revision: content_hash, in_project: null, motif: { ...motif, content_hash } });
const noop = () => {};
const card = (row: LibraryMotifRow | ProjectMotifRow = libraryRow()) => <MotifCard row={row} selected={false} fpsNum={60} fpsDen={1}
  onSelect={noop} onExport={noop} onHistory={noop} onDelete={noop} onTakeLibrary={noop} onSave={noop} onRemove={noop} />;
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
    // A library Motif's cover is captured from the library, not the project.
    expect(getCover).toHaveBeenCalledExactlyOnceWith('badge--library', 'first');
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
    view.rerender(card(libraryRow('second')));
    await screen.findByText('Cover unavailable');
    expect(screen.queryByRole('img')).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:first');
    expect(getCover).toHaveBeenLastCalledWith('badge--library', 'second');
    expect(screen.getByRole('button', { name: 'Export Motif ZIP' })).toBeTruthy();
  });
});
