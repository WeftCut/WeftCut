// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { AnimTrack } from "../ipc";
import * as mutationErrors from "../errors/tryMutate";
import { KeyframeField } from "./KeyframeField";

afterEach(cleanup);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const keyed = (t_us: number, value: number): AnimTrack<number> => ({
  mode: "Keyframed", extrapolate: { before: "Hold", after: "Hold" },
  value: [{ id: "a", t_us, value, in: { x: 2 / 3, y: 2 / 3, mode: "Free" }, out: { x: 1 / 3, y: 1 / 3, mode: "Free" }, continuity: "Broken", segment: { kind: "Linear" } }],
});

describe("KeyframeField (no stopwatch / timeline mode)", () => {
  it("commits an upserted key at tInLayerUs on blur", async () => {
    const onCommitTrack = vi.fn();
    render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 0)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={onCommitTrack}
        widgets={["number"]} step={1} showStopwatch={false}
      />,
    );
    const el = screen.getByLabelText("x");
    await userEvent.clear(el);
    await userEvent.type(el, "120");
    await userEvent.click(document.body); // blur → commit
    expect(onCommitTrack).toHaveBeenCalledTimes(1);
    const [paramKey, next] = onCommitTrack.mock.calls[0]!;
    expect(paramKey).toBe("x");
    expect(next.mode === "Keyframed" && next.value[0].value).toBe(120);
  });

  it("disables the input off-span when there is no stopwatch", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 0)} fallback={0}
        tInLayerUs={-100} playheadInSpan={false} onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch={false}
      />,
    );
    expect((screen.getByLabelText("x") as HTMLInputElement).disabled).toBe(true);
  });

  it("idle display follows the evaluated value (shown) when not editing", () => {
    const { rerender } = render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 10)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch={false}
      />,
    );
    expect((screen.getByLabelText("x") as HTMLInputElement).value).toBe("10");
    rerender(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 42)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch={false}
      />,
    );
    expect((screen.getByLabelText("x") as HTMLInputElement).value).toBe("42");
  });
});

describe("KeyframeField widget composition", () => {
  it.each(["keyboard", "drag"])("keeps opacity at 1 while the %s commit is awaiting its round trip", async (input) => {
    vi.useFakeTimers();
    try {
      const saved = deferred();
      const onCommitTrack = vi.fn(() => saved.promise);
      const field = (track: AnimTrack<number>) => (
        <KeyframeField
          layerId="motif" paramKey="opacity" label="opacity" track={track} fallback={1}
          tInLayerUs={0} playheadInSpan onCommitTrack={onCommitTrack}
          widgets={["slider", "number"]} step={0.01} min={0} max={1}
        />
      );
      const { rerender } = render(field(keyed(0, 0)));
      const slider = screen.getByRole("slider");
      if (input === "drag") {
        vi.stubGlobal("PointerEvent", MouseEvent);
        const control = document.querySelector(".app-slider-control")!;
        vi.spyOn(control, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 10));
        fireEvent.pointerDown(control, { button: 0, buttons: 1, clientX: 0, clientY: 5 });
        fireEvent.pointerMove(document, { buttons: 1, clientX: 100, clientY: 5 });
      } else {
        fireEvent.keyDown(slider, { key: "End" });
      }
      expect(slider.getAttribute("aria-valuenow")).toBe("1");
      await act(async () => { vi.advanceTimersByTime(250); });
      expect(onCommitTrack).toHaveBeenCalledTimes(1);
      expect(onCommitTrack.mock.calls[0]).toEqual(["opacity", expect.objectContaining({
        mode: "Keyframed", value: [expect.objectContaining({ t_us: 0, value: 1 })],
      })]);
      expect(slider.getAttribute("aria-valuenow")).toBe("1");
      if (input === "drag") fireEvent.pointerUp(document, { clientX: 100, clientY: 5 });
      await act(async () => {
        rerender(field(keyed(0, 1)));
        saved.resolve();
      });
      expect(slider.getAttribute("aria-valuenow")).toBe("1");
      // Once saved, external edits / undo must drive the field again.
      rerender(field(keyed(0, 0)));
      expect(slider.getAttribute("aria-valuenow")).toBe("0");
    } finally {
      cleanup();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("renders a readout span next to a slider", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="opacity" label="opacity" track={keyed(0, 0.5)} fallback={1}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["slider", "readout"]} step={0.01} min={0} max={1} showStopwatch={false}
      />,
    );
    expect(screen.getByRole("slider")).toBeTruthy();
    // `0.5`, not the old hard-coded `toFixed(2)`'s `0.50`: the readout formats
    // through the param's declared precision now, so it renders the same string
    // the editable number field would for the same value — and, more to the
    // point, one that parses back to exactly what is stored.
    expect(screen.getByText("0.5")).toBeTruthy();
  });

  it("renders a slider AND a number field bound to the same value", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="opacity" label="opacity" track={keyed(0, 0.5)} fallback={1}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["slider", "number"]} step={0.01} min={0} max={1} showStopwatch={false}
      />,
    );
    expect(screen.getByRole("slider")).toBeTruthy();
    // AppSlider also renders a visually-hidden <input type="range" aria-label>,
    // so getByLabelText("opacity") matches two inputs in jsdom. Scope to the
    // number field's input (type="text", aria-roledescription="Number field");
    // both inputs share the one draft value, so 0.5 still asserts the binding.
    const numberInput = screen
      .getAllByLabelText("opacity")
      .find((el) => (el as HTMLInputElement).type === "text") as HTMLInputElement;
    expect(numberInput.value).toBe("0.5");
  });
});

describe("KeyframeField (stopwatch / inspector mode)", () => {
  it("renders the stopwatch toggle when showStopwatch is set", () => {
    render(
      <KeyframeField
        layerId="L1" paramKey="x" label="x" track={keyed(0, 0)} fallback={0}
        tInLayerUs={0} playheadInSpan onCommitTrack={vi.fn()}
        widgets={["number"]} showStopwatch onMutated={async () => {}}
      />,
    );
    expect(document.querySelector(".anim-stopwatch")).toBeTruthy();
  });
});

describe("KeyframeField pending edits", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

  function field(onCommitTrack: (key: string, track: AnimTrack<number>) => void | Promise<void>, layerId = "motif") {
    return <KeyframeField
      layerId={layerId} paramKey="opacity" label="opacity" track={keyed(0, 0)} fallback={1}
      tInLayerUs={0} playheadInSpan onCommitTrack={onCommitTrack}
      widgets={["slider", "number"]} step={0.01} min={0} max={1}
    />;
  }

  it("does not let an earlier save clear a newer slider draft", async () => {
    const first = deferred();
    const second = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(field(save));
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "End" });
    await act(async () => { vi.advanceTimersByTime(250); });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(slider.getAttribute("aria-valuenow")).toBe("0.99");
    await act(async () => { first.resolve(); });
    expect(slider.getAttribute("aria-valuenow")).toBe("0.99");
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(save.mock.calls[1]![1].value[0].value).toBe(0.99);
    expect(slider.getAttribute("aria-valuenow")).toBe("0.99");
  });

  it("cancels a queued slider value when the sibling number field commits", async () => {
    const save = vi.fn(() => new Promise<void>(() => {}));
    render(field(save));
    fireEvent.keyDown(screen.getByRole("slider"), { key: "End" });
    const number = screen.getAllByLabelText("opacity").find(el => (el as HTMLInputElement).type === "text")!;
    fireEvent.focus(number);
    fireEvent.change(number, { target: { value: "0.5" } });
    fireEvent.blur(number);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]).toEqual(["opacity", expect.objectContaining({
      value: [expect.objectContaining({ value: 0.5 })],
    })]);
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("0.5");
  });

  it("cancels a pending slider timer when the bound layer changes", async () => {
    const save = vi.fn();
    const { rerender } = render(field(save));
    fireEvent.keyDown(screen.getByRole("slider"), { key: "End" });
    rerender(field(save, "other-motif"));
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("0");
  });

  it("does not let a previous layer's save clear the new layer's draft", async () => {
    const oldSave = deferred();
    const save = vi.fn(() => oldSave.promise);
    const { rerender } = render(field(save));
    fireEvent.keyDown(screen.getByRole("slider"), { key: "End" });
    await act(async () => { vi.advanceTimersByTime(250); });
    rerender(field(save, "other-motif"));
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    await act(async () => { oldSave.resolve(); });
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("0.01");
  });

  it("releases the draft and reports a failed save", async () => {
    const pending = deferred();
    const report = vi.spyOn(mutationErrors, "logMutationFailure").mockImplementation(() => {});
    render(field(() => pending.promise));
    fireEvent.keyDown(screen.getByRole("slider"), { key: "End" });
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("1");
    const error = new Error("Save refused");
    await act(async () => { pending.reject(error); });
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("0");
    expect(report).toHaveBeenCalledWith(error, "Edit keyframes");
  });
});
