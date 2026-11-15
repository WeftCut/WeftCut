// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GRID_OPACITY_MAX, GRID_OPACITY_MIN } from "../../shared/preview-grid";

const save = vi.hoisted(() => vi.fn(async (_patch: unknown) => ({})));
vi.mock("./appSettingsStore", () => ({
  usePreviewGrid: () => ({ opacity: 70 }),
  usePreviewSnapEnabled: () => true,
  usePreviewSnapStrengthPx: () => 12,
  setAppSettings: save,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CanvasSnapSettings, GridOpacitySettings } from "./SnapSettings";

describe("snap settings", () => {
  beforeEach(() => { save.mockClear(); });
  afterEach(cleanup);

  it("bounds grid visibility by the stored range, so Settings never hides the grid", () => {
    render(<GridOpacitySettings onError={vi.fn()} />);
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("min")).toBe(String(GRID_OPACITY_MIN));
    expect(slider.getAttribute("max")).toBe(String(GRID_OPACITY_MAX));
  });

  it("clamps a typed zero to the visible minimum", async () => {
    render(<GridOpacitySettings onError={vi.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ preview_grid: { opacity: GRID_OPACITY_MIN } }));
  });

  it("explains the canvas snap strength's unit", () => {
    render(<CanvasSnapSettings onError={vi.fn()} />);
    expect(screen.getByText("settings.preview_snap_strength_hint")).toBeTruthy();
  });
});
