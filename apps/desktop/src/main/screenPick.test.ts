import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenPickReply } from '../shared/screenPick';

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, (...args: any[]) => void>(),
  windows: [] as any[],
  capture: vi.fn(), autoReady: true,
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Contents extends EventEmitter {
    mainFrame = {}; send = vi.fn();
    destroyed = false;
    isDestroyed() { return this.destroyed; }
  }
  class Window extends EventEmitter {
    webContents = new Contents();
    destroyed = false; internal = false; focused = false;
    options: any;
    constructor(options?: any) { super(); this.options = options; mock.windows.push(this); }
    static fromWebContents(wc: any) { return mock.windows.find(w => w.webContents === wc) ?? null; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return true; }
    isMinimized() { return false; }
    isFocused() { return this.focused; }
    focus = vi.fn(() => { for (const w of mock.windows) w.focused = false; this.focused = true; });
    showInactive = vi.fn(); setMenu = vi.fn(); setAlwaysOnTop = vi.fn(); setVisibleOnAllWorkspaces = vi.fn();
    loadFile = vi.fn(async () => {
      if (mock.autoReady) mock.events.get('colorpick:ready')?.({sender:this.webContents,senderFrame:this.webContents.mainFrame});
    });
    loadURL = this.loadFile;
    destroy() { this.destroyed = true; this.webContents.destroyed = true; this.emit('closed'); }
  }
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: vi.fn(() => [
      {id:1,bounds:{x:-800,y:0,width:800,height:600},scaleFactor:1},
      {id:2,bounds:{x:0,y:0,width:1000,height:700},scaleFactor:2},
    ]),
    getCursorScreenPoint: () => ({x:0,y:0}), getDisplayNearestPoint: () => ({id:2}),
  });
  return { BrowserWindow: Window, screen,
    app: Object.assign(new EventEmitter(), {commandLine:{getSwitchValue:()=> 'x11'}}),
    desktopCapturer:{getSources:mock.capture},
    ipcMain:{handle:(channel:string,fn:any)=>mock.handlers.set(channel,fn),on:(channel:string,fn:any)=>mock.events.set(channel,fn)},
    systemPreferences:{getMediaAccessStatus:()=> 'granted'},
  };
});
vi.mock('./windows', () => ({
  hardenWindow: vi.fn(), markInternalWindow: (win: any) => { win.internal = true; },
  userFacingWindows: () => mock.windows.filter(w=>!w.internal && !w.destroyed),
}));
import { app, BrowserWindow, screen } from 'electron';
import { registerScreenPick } from './screenPick';

const source = (id: number, width: number, height: number) => ({display_id:String(id),thumbnail:{
  isEmpty:()=>false,getSize:()=>({width,height}),toPNG:()=>new Uint8Array([id]),
}});
const sources = () => [source(1,800,600),source(2,2000,1400)];
const event = (win: BrowserWindow) => ({sender:win.webContents,senderFrame:win.webContents.mainFrame});
const invoke = (channel: string, win: BrowserWindow, data?: unknown) => mock.handlers.get(channel)!(event(win),data);
const send = (channel: string, win: BrowserWindow, data?: unknown) => mock.events.get(channel)!(event(win),data);
const overlays = () => mock.windows.filter(w=>w.internal && !w.destroyed);
let owner: BrowserWindow;

beforeEach(() => {
  mock.windows.length = 0; mock.handlers.clear(); mock.events.clear(); mock.autoReady = true;
  mock.capture.mockReset().mockResolvedValue(sources());
  app.removeAllListeners(); screen.removeAllListeners();
  owner = new BrowserWindow();
  registerScreenPick();
});
afterEach(() => { app.emit('before-quit', {}); vi.useRealTimers(); });
const start = (id = 'one'): Promise<ScreenPickReply> => invoke('colorpick:start',owner,{id,hint:'localized hint'});

describe('desktop pick session', () => {
  it('captures both physical resolutions before showing, marks internal, and commits once', async () => {
    const result = start();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    await vi.waitFor(() => expect(overlays()[0].showInactive).toHaveBeenCalledOnce());
    expect(mock.capture).toHaveBeenNthCalledWith(1,{types:['screen'],thumbnailSize:{width:800,height:600}});
    expect(mock.capture).toHaveBeenNthCalledWith(2,{types:['screen'],thumbnailSize:{width:2000,height:1400}});
    expect(overlays()[0].options.x).toBe(-800);
    expect(overlays()[1].options.x).toBe(0);
    expect(invoke('colorpick:snapshot',overlays()[1]).width).toBe(2000);
    const overlay = overlays()[1];
    send('colorpick:hover',overlay,'#ABCDEF');
    expect(owner.webContents.send).toHaveBeenCalledWith('colorpick:hover',{id:'one',hex:'#abcdef'});
    send('colorpick:finish',overlay,'#ABCDEF');
    send('colorpick:finish',overlay,'#ffffff'); // stale sender after destruction
    expect(await result).toEqual({kind:'picked',hex:'#abcdef'});
    expect(overlays()).toHaveLength(0);
    expect(owner.focus).toHaveBeenCalledOnce();
    expect(screen.listenerCount('display-removed')).toBe(0);
  });
  it('does not show any screen until every renderer has decoded its screenshot', async () => {
    mock.autoReady = false;
    const result = start();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    send('colorpick:ready',overlays()[0]);
    await Promise.resolve();
    expect(overlays().every(o=>o.showInactive.mock.calls.length===0)).toBe(true);
    send('colorpick:ready',overlays()[1]);
    await vi.waitFor(() => expect(overlays()[0].showInactive).toHaveBeenCalledOnce());
    invoke('colorpick:cancel',owner,'one');
    expect(await result).toEqual({kind:'cancelled'});
  });
  it('cancellation during capture resolves immediately and late capture opens no windows', async () => {
    let release!: (value: any) => void;
    mock.capture.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
    const result = start();
    invoke('colorpick:cancel',owner,'one');
    expect(await result).toEqual({kind:'cancelled'});
    release(sources()); await Promise.resolve(); await Promise.resolve();
    expect(overlays()).toHaveLength(0);
  });
  it('does not steal focus if the user leaves the editor during capture', async () => {
    let release!: (value: any) => void;
    mock.capture.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
    const result = start();
    owner.emit('blur');
    expect(await result).toEqual({kind:'cancelled'});
    release(sources()); await Promise.resolve(); await Promise.resolve();
    expect(overlays()).toHaveLength(0);
    expect(owner.focus).not.toHaveBeenCalled();
  });
  it('ignores cancellation when there is no session, including an absent id', () => {
    expect(()=>invoke('colorpick:cancel',owner)).not.toThrow();
  });
  it('a new session preempts a pending old one without its late result replacing the new one', async () => {
    let release!: (value: any) => void;
    mock.capture.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
    const first = start('old'), second = start('new');
    expect(await first).toEqual({kind:'cancelled'});
    release(sources());
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    invoke('colorpick:cancel',owner,'old'); // stale cancellation cannot kill the winner
    send('colorpick:finish',overlays()[0],'#123456');
    expect(await second).toEqual({kind:'picked',hex:'#123456'});
  });
  it('denies screenshot reads, finish, cancel and hover from other windows or subframes', async () => {
    const result = start();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    const other = new BrowserWindow();
    expect(()=>invoke('colorpick:snapshot',other)).toThrow();
    invoke('colorpick:cancel',other,'one');send('colorpick:finish',other,'#ffffff');send('colorpick:hover',other,'#ffffff');
    const overlay = overlays()[0];
    mock.events.get('colorpick:finish')!({...event(overlay),senderFrame:{}},'#ffffff');
    send('colorpick:finish',overlay,'invalid');
    expect(owner.webContents.send).not.toHaveBeenCalled();
    expect(overlays()).toHaveLength(2);
    invoke('colorpick:cancel',owner,'one');
    expect(await result).toEqual({kind:'cancelled'});
  });
  it.each(['display-added','display-removed','display-metrics-changed'])('cleans up on %s', async change => {
    const result = start();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    screen.emit(change);
    expect(await result).toEqual({kind:'cancelled'});
    expect(overlays()).toHaveLength(0);
  });
  it.each(['closed','render-process-gone','did-start-navigation'])('cancels when owner emits %s', async reason => {
    const result = start();
    await vi.waitFor(() => expect(overlays()).toHaveLength(2));
    (reason === 'closed' ? owner : owner.webContents).emit(reason);
    expect(await result).toEqual({kind:'cancelled'});
    expect(overlays()).toHaveLength(0);
    expect(owner.focus).not.toHaveBeenCalled();
  });
  it('reports capture failure without leaving an overlay', async () => {
    mock.capture.mockResolvedValueOnce([source(1,150,112)]);
    expect(await start()).toEqual({kind:'error',reason:'capture'});
    expect(overlays()).toHaveLength(0);
  });
  it('cleans up if an overlay fails after creation', async () => {
    mock.autoReady=false;
    const result=start();
    await vi.waitFor(()=>expect(overlays()).toHaveLength(2));
    send('colorpick:failed',overlays()[0]);
    expect(await result).toEqual({kind:'error',reason:'capture'});
    expect(overlays()).toHaveLength(0);
  });
  it('times out a renderer that never becomes ready', async () => {
    vi.useFakeTimers(); mock.autoReady=false;
    const result=start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await result).toEqual({kind:'error',reason:'timeout'});
    expect(overlays()).toHaveLength(0);
  });
  it('allows focus to cross overlays but cancels when another app takes focus', async () => {
    const result=start();
    await vi.waitFor(()=>expect(overlays()[0]?.showInactive).toHaveBeenCalled());
    vi.useFakeTimers();
    const [a,b]=overlays();a.emit('blur');b.focused=true;
    await vi.advanceTimersByTimeAsync(150);expect(overlays()).toHaveLength(2);
    a.focused=false;b.focused=false;b.emit('blur');
    await vi.advanceTimersByTimeAsync(150);
    expect(await result).toEqual({kind:'cancelled'});
    expect(owner.focus).not.toHaveBeenCalled();
  });
});
