// @vitest-environment jsdom
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import i18n from "../i18n";
import type { ProjectSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { summaryFixture } from "../testing/summaryFixture";
import { PreviewSurface, type PreviewSurfaceHandle } from "./PreviewSurface";

/// The compositor's side of the surface: what it was told about suspension,
/// and the order its decoders were yielded and taken back.
const pixi = vi.hoisted(() => ({ suspended: false, log: [] as string[] }));

vi.mock("../render/PixiPreview", async () => {
  const React = await import("react");
  return {
    PixiPreview: React.forwardRef(function FakePixiPreview(props: { exportSuspended?: boolean }, ref) {
      pixi.suspended = props.exportSuspended ?? false;
      React.useImperativeHandle(ref, () => ({
        suspendForExport: () => { pixi.log.push("yield"); return () => { pixi.log.push("restore"); }; },
      }), []);
      return React.createElement("canvas");
    }),
  };
});
// The surface's other overlays follow the selection and the tools, not suspension.
vi.mock("./TextToolOverlay", () => ({ TextToolOverlayHost: () => null }));
vi.mock("./SafeAreaGuides", () => ({ SafeAreaGuidesHost: () => null }));
vi.mock("./TransformGizmo", () => ({ TransformGizmoHost: () => null }));
vi.mock("./CropOverlay", () => ({ CropOverlayHost: () => null }));
vi.mock("./PreviewHandTool", () => ({ PreviewHandTool: () => null }));
vi.mock("./previewViewGestures", () => ({ usePreviewViewGestures: () => {} }));

function fixture(): ProjectSummary {
  return summaryFixture({
    project_id: "p1",
    name: "fixture",
    media: [],
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    audio_roles: [],
    root: {
      width: 1280, height: 720, fps_num: 30, fps_den: 1, duration_pinned: false, fps_locked: false,
      duration_us: 0, tracks: [], links: [], markers: [], transitions: [],
    },
  }) as unknown as ProjectSummary;
}

function mount() {
  const ref = createRef<PreviewSurfaceHandle>();
  render(<PreviewSurface ref={ref} hasContent />);
  return ref.current!;
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useProjectStore.getState().apply(fixture());
  pixi.suspended = false;
  pixi.log.length = 0;
});
afterEach(cleanup);

describe("a suspended preview says who is using it", () => {
  it.each([
    ["agent", "An agent is viewing"],
    ["export", "Preparing export"],
  ] as const)("names the %s for as long as it holds the decoders, and nothing after", (by, text) => {
    const surface = mount();
    expect(screen.queryByRole("status")).toBeNull();

    let restore!: () => void;
    act(() => { restore = surface.suspendForExport(by); });
    expect(screen.getByRole("status").textContent).toBe(text);
    expect(pixi.suspended).toBe(true);

    act(() => restore());
    expect(screen.queryByRole("status")).toBeNull();
    expect(pixi.suspended).toBe(false);
    expect(pixi.log).toEqual(["yield", "restore"]);
  });

  it("reads in the interface language", async () => {
    const surface = mount();
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    act(() => { surface.suspendForExport("agent"); });
    expect(screen.getByRole("status").textContent).toBe("Agent 正在查看");
  });
});
