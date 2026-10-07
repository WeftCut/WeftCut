// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaThumbnail } from "./MediaThumbnail";
import { useProjectStore } from "../state/projectStore";
import { summaryFixture } from "../testing/summaryFixture";
import { getMediaThumbnail, type MediaSummary } from "../ipc";

vi.mock("@/bridge/events", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../ipc", async (original) => ({
  ...await original<typeof import("../ipc")>(),
  getMediaThumbnail: vi.fn(async () => "data:image/jpeg;base64,cG9zdGVy"),
}));
afterEach(() => { cleanup(); useProjectStore.getState().apply(null); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("media pool poster visibility", () => {
  it("only fetches visible cards, drops offscreen image references and reuses cached posters", async () => {
    let observe!: (visible: boolean) => void;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void) {
        observe = (visible) => callback([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]);
      }
      observe() {}
      disconnect = disconnect;
    });
    useProjectStore.getState().apply(summaryFixture({ media: [{ id: 'visible', path: '/video.mov', kind: 'Video', size_bytes: 10 } as MediaSummary] }));
    const view = render(<MediaThumbnail mediaId="visible" mediaKind="Video" />);
    expect(getMediaThumbnail).not.toHaveBeenCalled();
    await act(async () => { observe(true); });
    expect(getMediaThumbnail).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('img')).not.toBeNull();
    act(() => { observe(false); });
    expect(view.container.querySelector('img')).toBeNull();
    await act(async () => { observe(true); });
    expect(getMediaThumbnail).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('img')).not.toBeNull();
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
