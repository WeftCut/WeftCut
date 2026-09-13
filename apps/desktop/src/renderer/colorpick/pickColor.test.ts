// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScreenPickReply } from '../../shared/screenPick';

const { screenPick } = vi.hoisted(() => ({ screenPick: vi.fn<(...args: any[]) => Promise<ScreenPickReply>>() }));
vi.mock('./screenPick', () => ({ screenPick }));

const { logEmit } = vi.hoisted(() => ({ logEmit: vi.fn(async () => {}) }));
vi.mock("../ipc", () => ({ logEmit }));
const { captureWindowSnapshot } = vi.hoisted(() => ({
  captureWindowSnapshot: vi.fn(async () => ({
    data: { data: new Uint8ClampedArray(4), width: 1, height: 1 } as unknown as ImageData,
    scaleX: 1,
    scaleY: 1,
  })),
}));
vi.mock("./snapshot", () => ({ captureWindowSnapshot }));

import { pickColor, startScreenPick, usePickSessionStore } from "./pickColor";
import {
  clearPreviewSampler,
  getPreviewSampler,
  registerPreviewSampler,
  type PreviewSampler,
} from "./previewSamplerRegistry";

const goodSampler = (): PreviewSampler => ({
  captureFrame: vi.fn(async () => ({ pixels: new Uint8Array([1, 2, 3, 255]), width: 1, height: 1 })),
  mapClientToComposition: () => ({ x: 0, y: 0 }),
  canvasRect: () => null,
});

afterEach(() => {
  usePickSessionStore.getState().session?.settle(null);
  const s = getPreviewSampler();
  if (s) clearPreviewSampler(s);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("pickColor", () => {
  it('keeps the same session after a desktop capture failure so in-app sampling can commit', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    screenPick.mockResolvedValueOnce({kind:'error',reason:'permission'});
    const result=pickColor();
    await vi.waitFor(()=>expect(usePickSessionStore.getState().session).not.toBeNull());
    const session=usePickSessionStore.getState().session!;
    await startScreenPick(session,'hint');
    expect(usePickSessionStore.getState()).toMatchObject({session,screenPicking:false,screenError:'permission'});
    session.settle({hex:'#010203',source:'composition'});
    expect(await result).toEqual({hex:'#010203',source:'composition'});
    expect(usePickSessionStore.getState().screenError).toBeNull();
  });
  it('preempts a desktop session, aborts its native request and ignores its late result', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    let release!: (result: ScreenPickReply)=>void;
    screenPick.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
    const first=pickColor();
    await vi.waitFor(()=>expect(usePickSessionStore.getState().session).not.toBeNull());
    const handoff=startScreenPick(usePickSessionStore.getState().session!,'hint');
    await vi.waitFor(()=>expect(screenPick).toHaveBeenCalledOnce());
    const signal=screenPick.mock.calls[0]![0] as AbortSignal;
    const second=pickColor();
    expect(await first).toBeNull();expect(signal.aborted).toBe(true);
    await vi.waitFor(()=>expect(usePickSessionStore.getState().session).not.toBeNull());
    const winner=usePickSessionStore.getState().session!;
    release({kind:'picked',hex:'#ffffff'});await handoff;
    expect(usePickSessionStore.getState().session).toBe(winner);
    winner.settle(null);expect(await second).toBeNull();
  });
  it("opens a session and resolves through settle", async () => {
    registerPreviewSampler(goodSampler());
    const p = pickColor();
    await vi.waitFor(() => expect(usePickSessionStore.getState().session).not.toBeNull());
    usePickSessionStore.getState().session!.settle({ hex: "#010203", source: "composition" });
    await expect(p).resolves.toEqual({ hex: "#010203", source: "composition" });
    expect(usePickSessionStore.getState().session).toBeNull();
  });
  it("forwards excludeEffectId into captureFrame", async () => {
    const s = goodSampler();
    registerPreviewSampler(s);
    const p = pickColor({ excludeEffectId: "E9" });
    await vi.waitFor(() => expect(usePickSessionStore.getState().session).not.toBeNull());
    expect(s.captureFrame).toHaveBeenCalledWith({ excludeEffectId: "E9" });
    usePickSessionStore.getState().session!.settle(null);
    await expect(p).resolves.toBeNull();
  });
  it("a new call preempts the old session with null", async () => {
    registerPreviewSampler(goodSampler());
    const first = pickColor();
    await vi.waitFor(() => expect(usePickSessionStore.getState().session).not.toBeNull());
    const second = pickColor();
    await expect(first).resolves.toBeNull();
    await vi.waitFor(() => expect(usePickSessionStore.getState().session).not.toBeNull());
    usePickSessionStore.getState().session!.settle(null);
    await expect(second).resolves.toBeNull();
  });
  it("resolves null with no session when BOTH buffers fail", async () => {
    // No sampler registered; snapshot rejects.
    captureWindowSnapshot.mockRejectedValueOnce(new Error("nope"));
    await expect(pickColor()).resolves.toBeNull();
    expect(usePickSessionStore.getState().session).toBeNull();
    expect(logEmit).toHaveBeenCalled();
  });
  it("preempts a call still capturing buffers (no orphaned promise, no clobber)", async () => {
    const release: Array<() => void> = [];
    registerPreviewSampler({
      captureFrame: () =>
        new Promise((res) =>
          release.push(() => res({ pixels: new Uint8Array([1, 2, 3, 255]), width: 1, height: 1 })),
        ),
      mapClientToComposition: () => null,
      canvasRect: () => null,
    });
    const first = pickColor();
    const second = pickColor(); // no await between — both mid-capture
    expect(release.length).toBe(2);
    release[1]!(); // the NEWER call's capture lands first
    await vi.waitFor(() => expect(usePickSessionStore.getState().session).not.toBeNull());
    release[0]!(); // the OLDER call's capture lands after the winner installed
    await expect(first).resolves.toBeNull(); // resolved (not hung), and…
    const live = usePickSessionStore.getState().session!;
    live.settle({ hex: "#010203", source: "composition" });
    // …the winner's session was NOT clobbered by the loser's late install.
    await expect(second).resolves.toEqual({ hex: "#010203", source: "composition" });
  });
});
