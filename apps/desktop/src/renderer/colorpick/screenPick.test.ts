// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screenPick, screenPickAvailable } from './screenPick';
import type { ScreenPickApi, ScreenPickHover, ScreenPickReply } from '../../shared/screenPick';

afterEach(() => { vi.unstubAllGlobals(); });
function setup(start: ScreenPickApi['start'] = async () => ({ kind: 'picked', hex: '#123456' })) {
  let listener!: (event: ScreenPickHover) => void;
  const unsubscribe = vi.fn();
  const api = { start: vi.fn(start), cancel: vi.fn(async () => {}),
    onHover: vi.fn((cb: typeof listener) => { listener = cb; return unsubscribe; }) };
  Object.defineProperty(window, 'api', { configurable: true, value: { colorPick: api } });
  return { api, hover: (event: ScreenPickHover) => listener(event), unsubscribe };
}

describe('desktop pick bridge', () => {
  it('reports unsupported without the bridge', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: undefined });
    expect(screenPickAvailable()).toBe(false);
    expect(await screenPick(new AbortController().signal, '')).toEqual({kind:'error',reason:'unsupported'});
  });
  it('returns the result and releases the hover subscription', async () => {
    const { api, unsubscribe } = setup();
    expect(await screenPick(new AbortController().signal, 'localized hint')).toEqual({kind:'picked',hex:'#123456'});
    expect(api.start).toHaveBeenCalledWith({id:expect.any(String),hint:'localized hint'});
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('only forwards hover from its own request and suppresses late results after abort', async () => {
    let resolve!: (reply: ScreenPickReply) => void;
    const { api, hover, unsubscribe } = setup(() => new Promise(r => { resolve = r; }));
    const controller = new AbortController(), onHover = vi.fn();
    const picking = screenPick(controller.signal, '', onHover);
    const id = api.start.mock.calls[0]![0].id;
    hover({id:'stale',hex:'#ff0000'});
    hover({id,hex:'#123456'});
    expect(onHover).toHaveBeenCalledExactlyOnceWith('#123456');
    controller.abort();
    hover({id,hex:'#ffffff'});
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(id);
    resolve({kind:'picked',hex:'#ffffff'});
    expect(await picking).toEqual({kind:'cancelled'});
    expect(onHover).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('does not start an already cancelled request', async () => {
    const { api } = setup();
    const controller = new AbortController(); controller.abort();
    expect(await screenPick(controller.signal, '')).toEqual({kind:'cancelled'});
    expect(api.start).not.toHaveBeenCalled();
  });
  it('converts bridge errors to a recoverable capture failure', async () => {
    const { unsubscribe } = setup(async () => { throw Error('IPC'); });
    expect(await screenPick(new AbortController().signal, '')).toEqual({kind:'error',reason:'capture'});
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
