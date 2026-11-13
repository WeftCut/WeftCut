// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import i18n from "../i18n";
import type { ProjectSummary } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import { summaryFixture } from "../testing/summaryFixture";
import { PreviewSurface } from "./PreviewSurface";
import { suspendExportPreview } from "../render/exportPreviewSuspension";

vi.mock("../render/PixiPreview", () => ({ PixiPreview: () => null }));
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

function mount(backgroundExportActive = false) {
  return render(<PreviewSurface hasContent backgroundExportActive={backgroundExportActive} />);
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useProjectStore.getState().apply(fixture());
});
afterEach(cleanup);

describe("a suspended preview says who is using it", () => {
  it.each([
    ["agent", "An agent is viewing"],
    ["export", "Exporting"],
  ] as const)("names the %s for as long as it holds the decoders, and nothing after", (by, text) => {
    mount();
    expect(screen.queryByRole("status")).toBeNull();

    let restore!: () => void;
    act(() => { restore = suspendExportPreview(by); });
    expect(screen.getByRole("status").textContent).toBe(text);

    act(() => restore());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reads in the interface language", async () => {
    mount();
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    let restore!: () => void;
    act(() => { restore = suspendExportPreview("agent"); });
    expect(screen.getByRole("status").textContent).toBe("Agent 正在查看");
    act(() => restore());
  });
});

it("a remounted beta preview observes the same preparation hold", () => {
  const first = mount(true);
  let restore!: () => void;
  act(() => { restore = suspendExportPreview("export"); });
  first.unmount();
  mount(true);
  expect(screen.getByRole("status").textContent).toBe("Preparing export");
  act(() => restore());
  expect(screen.queryByRole("status")).toBeNull();
});
