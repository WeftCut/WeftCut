// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { useTrackReorder } from "./useTrackReorder";
import type { TrackSummary } from "../../ipc";

const move = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../ipc", async (original) => ({ ...await original<typeof import("../../ipc")>(), moveTrack: move }));
const makeTrack = (id: string): TrackSummary => ({ id, kind: "Video", role: null, label: id, layers: [], enabled: true, locked: false, muted: false, solo: false, transient: true });
const initial = [makeTrack("top"), makeTrack("middle"), makeTrack("bottom")];
const onMutated = vi.fn().mockResolvedValue(undefined);

function Harness({ tracks = initial, enabled = true }: { tracks?: TrackSummary[]; enabled?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const reorder = useTrackReorder({ tracks, enabled, viewportRef: viewport, onMutated });
  return <>
    <button onClick={() => reorder.reveal("new")}>Reveal new</button>
    <div ref={viewport} data-testid="viewport" style={{ overflowY: "auto" }}>
      <div ref={(el) => { reorder.containerRef.current = el; }}>
        {tracks.map((track, index) => <div key={track.id} data-testid={track.id} ref={(el) => reorder.setRow(track.id, index, el)}>
          <button onPointerDown={(e) => reorder.startDrag(index, e)}>{track.id}</button>
        </div>)}
        <output>{reorder.indicatorGap ?? "idle"}</output>
      </div>
    </div>
  </>;
}
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 500, width: 500, x: 0, y: top, toJSON() {} });

afterEach(() => { cleanup(); vi.restoreAllMocks(); move.mockClear(); onMutated.mockClear(); });

describe("track gesture and reveal", () => {
  it("keeps scrolling at an edge without pointer motion and stops after cancellation", () => {
    let frame: FrameRequestCallback | undefined;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const view = render(<Harness />);
    const viewport = view.getByTestId("viewport");
    Object.defineProperties(viewport, { scrollHeight: { value: 400 }, clientHeight: { value: 100 } });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(0, 100));
    initial.forEach((track, i) => vi.spyOn(view.getByTestId(track.id), "getBoundingClientRect").mockImplementation(() => rect(i * 80 - viewport.scrollTop, 80)));
    fireEvent.pointerDown(view.getByText("top", { selector: "button" }), { button: 0, clientY: 10 });
    fireEvent.pointerMove(window, { clientY: 95 });
    expect(raf).toHaveBeenCalled();
    act(() => frame!(0));
    expect(viewport.scrollTop).toBe(12);
    act(() => frame!(16));
    expect(viewport.scrollTop).toBe(24);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cancel).toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(move).not.toHaveBeenCalled();
  });

  it("cancels when track identities change during a drag", () => {
    const view = render(<Harness />);
    initial.forEach((track, i) => vi.spyOn(view.getByTestId(track.id), "getBoundingClientRect").mockReturnValue(rect(i * 80, 80)));
    fireEvent.pointerDown(view.getByText("top", { selector: "button" }), { button: 0, clientY: 10 });
    fireEvent.pointerMove(window, { clientY: 240 });
    view.rerender(<Harness tracks={[makeTrack("new"), ...initial]} />);
    fireEvent.pointerUp(window);
    expect(move).not.toHaveBeenCalled();
    expect(view.container.querySelector("output")?.textContent).toBe("idle");
  });

  it("waits for a spawned row, reveals it vertically once and preserves horizontal scroll", async () => {
    const view = render(<Harness />);
    const viewport = view.getByTestId("viewport");
    viewport.scrollTop = 300;
    viewport.scrollLeft = 450;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(100, 200));
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      return this.dataset.testid === "new" ? rect(-200, 80) : rect(0, 80);
    });
    fireEvent.click(view.getByText("Reveal new"));
    expect(viewport.scrollTop).toBe(300);
    view.rerender(<Harness tracks={[makeTrack("new"), ...initial]} />);
    await waitFor(() => expect(viewport.scrollTop).toBe(0));
    expect(viewport.scrollLeft).toBe(450);
    viewport.scrollTop = 50;
    view.rerender(<Harness tracks={[makeTrack("new"), ...initial]} />);
    expect(viewport.scrollTop).toBe(50);
    measure.mockRestore();
  });
});
