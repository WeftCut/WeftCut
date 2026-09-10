// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../i18n";
import { EditableTextGizmo, InlineTextEditor } from "./InlineTextEditor";
import { updateLayerParams, type CompositionSummary, type LayerSummary } from "../ipc";
import { registerGizmoProbe, clearGizmoProbe, type GizmoProbe } from "./gizmoProbeRegistry";
import { appActionsSuspended } from "../shortcuts/useShortcuts";
import {
  beginTextEdit,
  consumesPointerDown,
  endTextEdit,
  textEditingLayerId,
  useTextEditingStore,
} from "../state/textEditingStore";

vi.mock("../ipc", async importActual => ({
  ...await importActual<typeof import("../ipc")>(),
  updateLayerParams: vi.fn().mockResolvedValue(undefined),
  logEmit: vi.fn().mockResolvedValue(undefined),
}));

const stat = (value: number) => ({ mode: "Static" as const, value });
const layer = {
  id: "title", kind: "Text", label: null, enabled: true, locked: false,
  t_start_us: 0, t_end_us: 5_000_000, color_hint: "#ffffff", effects: [],
  params: {
    kind: "Text" as const, content: "Hello", font_family: "Liberation Sans", font_size_px: 48,
    weight: 400, italic: false, align: "Center" as const, valign: "Middle" as const,
    color: { mode: "Static" as const, value: { r: 255, g: 255, b: 255, a: 255 } },
    x: stat(640), y: stat(360), anchor_x: stat(0.5), anchor_y: stat(0.5),
    scale_x: stat(1), scale_y: stat(1), scale_linked: true, rotation_deg: stat(0), opacity: stat(1),
    outline: null, shadow: null, box_w: 400, box_h: 100, line_height: 0, letter_spacing: 0,
  },
} satisfies LayerSummary;
const composition = { width: 1280, height: 720 } as CompositionSummary;
const probe: GizmoProbe = {
  canvasRect: () => new DOMRect(10, 20, 640, 360),
  naturalSizeOf: () => ({ w: 400, h: 100 }),
  textFitOf: () => ({ authoredPx: 48, effectivePx: 40, overflowing: false }),
};

beforeEach(() => {
  vi.mocked(updateLayerParams).mockResolvedValue(undefined);
  registerGizmoProbe(probe);
});
afterEach(() => {
  cleanup();
  clearGizmoProbe(probe);
  useTextEditingStore.setState({ layerId: null, closingPointerStamp: null });
  vi.clearAllMocks();
});

function setup() {
  const onDone = vi.fn();
  const view = render(<InlineTextEditor layer={layer} composition={composition} onDone={onDone} />);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  return { ...view, input, onDone };
}

describe("in-preview text editing", () => {
  it("positions the editor over the box using the preview scale and rendered font size", () => {
    const { input } = setup();
    expect(input.style.left).toBe("230px");
    expect(input.style.top).toBe("175px");
    expect(input.style.transform).toBe("rotate(0deg) scale(0.5, 0.5)");
    expect(input.style.fontSize).toBe("40px");
    expect(document.activeElement).toBe(input);
    expect(appActionsSuspended()).toBe(true);
  });

  it("keeps multiline CJK drafts local and saves only content once, even when blur follows submit", async () => {
    const { input, onDone } = setup();
    fireEvent.change(input, { target: { value: "你好\n第二行" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateLayerParams).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.blur(input);
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(updateLayerParams).toHaveBeenCalledExactlyOnceWith("title", { kind: "Text", content: "你好\n第二行" });
  });

  it("lets the IME consume Enter and Escape before handling editor commands", async () => {
    const { input, onDone } = setup();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "中文" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(updateLayerParams).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });

  it("cancels with Escape without committing on the subsequent blur", () => {
    const { input, onDone } = setup();
    fireEvent.change(input, { target: { value: "Discard" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onDone).toHaveBeenCalledOnce();
    expect(updateLayerParams).not.toHaveBeenCalled();
  });

  it("waits for the final IME text when an outside click finishes composition", async () => {
    const { input, onDone } = setup();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "zhong" } });
    fireEvent.pointerDown(document.body);
    fireEvent.blur(input);
    expect(updateLayerParams).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "中" } });
    fireEvent.compositionEnd(input);
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(updateLayerParams).toHaveBeenCalledExactlyOnceWith("title", { kind: "Text", content: "中" });
  });

  it("saves on an outside click, including an empty string", async () => {
    const { input, onDone } = setup();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(updateLayerParams).toHaveBeenCalledExactlyOnceWith("title", { kind: "Text", content: "" });
  });

  it("does not create history for unchanged text or write on project unmount", () => {
    const { input, unmount } = setup();
    fireEvent.blur(input);
    unmount();
    const next = setup();
    fireEvent.change(next.input, { target: { value: "Unsaved" } });
    next.unmount();
    expect(updateLayerParams).not.toHaveBeenCalled();
    expect(appActionsSuspended()).toBe(false);
  });

  // The gizmo reads WHICH layer is being edited off the store, so the Text tool
  // can open an editor from outside it — and a request naming another layer
  // opens nothing here.
  it("opens and closes with the editing store, for its own layer only", () => {
    render(
      <EditableTextGizmo layer={layer} composition={composition} locked={false}>
        {(onEdit) => <button type="button" onClick={onEdit}>box</button>}
      </EditableTextGizmo>,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    act(() => beginTextEdit("someone-else"));
    expect(screen.queryByRole("textbox")).toBeNull();
    act(() => beginTextEdit("title"));
    expect(screen.getByRole("textbox")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(textEditingLayerId()).toBeNull();
    // The gizmo's own entry points write the same store.
    fireEvent.click(screen.getByRole("button", { name: "box" }));
    expect(textEditingLayerId()).toBe("title");
    act(() => endTextEdit("title"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  // The press that closes the editor from outside is marked before the save,
  // so the Text tool, which sees the same event afterwards, can decline to
  // create a layer under it.
  it("marks the outside press that closes it as consumed", () => {
    setup();
    const press = new PointerEvent("pointerdown", { bubbles: true });
    document.body.dispatchEvent(press);
    expect(consumesPointerDown(press)).toBe(true);
    expect(consumesPointerDown(press)).toBe(false);
  });

  // The focus-region listener blurs the field at window capture, BEFORE the
  // same pointerdown reaches the editor's own listener. A blur that closed the
  // editor synchronously would take that listener with it and the press would
  // go unstamped — so the blur's close is deferred past the press.
  it("lets the press that blurred it stamp itself before the blur closes it", async () => {
    const { input, onDone } = setup();
    fireEvent.blur(input);
    expect(onDone).not.toHaveBeenCalled();
    const press = new PointerEvent("pointerdown", { bubbles: true });
    document.body.dispatchEvent(press);
    expect(onDone).toHaveBeenCalledOnce();
    expect(consumesPointerDown(press)).toBe(true);
    // The deferred blur finds the session finished and closes nothing twice.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("saves on a blur with no press behind it, one task later", async () => {
    const { input, onDone } = setup();
    fireEvent.change(input, { target: { value: "Tabbed away" } });
    fireEvent.blur(input);
    expect(updateLayerParams).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(updateLayerParams).toHaveBeenCalledExactlyOnceWith("title", { kind: "Text", content: "Tabbed away" });
  });

  it("retains the draft for retry when saving fails", async () => {
    vi.mocked(updateLayerParams).mockRejectedValueOnce(new Error("save failed"));
    const { input, onDone } = setup();
    fireEvent.change(input, { target: { value: "Keep this" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await screen.findByRole("alert");
    expect(input.value).toBe("Keep this");
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });
});
