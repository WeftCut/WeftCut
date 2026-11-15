// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "../i18n";
import i18n from "../i18n";
import { DEFAULT_PREVIEW_GRID, type PreviewGridSettings } from "../../shared/preview-grid";
import { useAppSettingsStore } from "../settings/appSettingsStore";
import { PreviewGridToolbar } from "./PreviewGridToolbar";

function setGrid(patch: Partial<PreviewGridSettings>): void {
  act(() => {
    useAppSettingsStore.setState((s) => ({
      settings: { ...s.settings, preview_grid: { ...s.settings.preview_grid, ...patch } },
    }));
  });
}

/// Inside a focus region, as the toolbar always is: the preview Panel's root.
function renderInRegion() {
  return render(
    <div data-focus-region="preview" tabIndex={-1} data-testid="region">
      <PreviewGridToolbar />
    </div>,
  );
}

const columnsField = () =>
  screen.getByRole("textbox", { name: i18n.t("preview.grid_columns") }) as HTMLInputElement;

beforeEach(() => {
  setGrid({ ...DEFAULT_PREVIEW_GRID, enabled: true, column_divisions: 4 });
});

afterEach(() => {
  cleanup();
  setGrid(DEFAULT_PREVIEW_GRID);
});

describe("PreviewGridToolbar", () => {
  it("shows the stored count, and follows it when it changes elsewhere", () => {
    renderInRegion();
    expect(columnsField().value).toBe("4");
    setGrid({ column_divisions: 6 });
    expect(columnsField().value).toBe("6");
  });

  it("keeps the field's own value while it has focus, and follows the store again after", () => {
    renderInRegion();
    const field = columnsField();
    act(() => field.focus());
    setGrid({ column_divisions: 6 });
    expect(field.value).toBe("4");

    act(() => field.blur());
    setGrid({ column_divisions: 8 });
    expect(field.value).toBe("8");
  });

  it("hands focus back to the preview's region on Enter", () => {
    renderInRegion();
    const field = columnsField();
    act(() => field.focus());
    fireEvent.keyUp(field, { key: "Enter" });
    expect(document.activeElement).toBe(screen.getByTestId("region"));
  });

  it("names the eye once and reports whether the lines show through aria-pressed", () => {
    renderInRegion();
    const eye = screen.getByTestId("grid-eye");
    const name = eye.getAttribute("aria-label");
    expect(eye.getAttribute("aria-pressed")).toBe("true");
    setGrid({ hidden: true });
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    expect(eye.getAttribute("aria-label")).toBe(name);
  });

  it("is absent while the grid is off", () => {
    setGrid({ enabled: false });
    renderInRegion();
    expect(screen.queryByTestId("preview-grid-toolbar")).toBeNull();
  });
});
