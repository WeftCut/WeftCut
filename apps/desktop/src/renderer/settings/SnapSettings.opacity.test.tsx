// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ opacity: 70 }));
const save = vi.hoisted(() => vi.fn(async (_patch: unknown) => ({})));
vi.mock("./appSettingsStore", () => ({
  usePreviewGrid: () => ({ opacity: state.opacity }),
  setAppSettings: save,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { GridOpacitySettings } from "./SnapSettings";

describe("Grid visibility in Settings", () => {
  beforeEach(() => { state.opacity = 70; save.mockClear(); });
  afterEach(cleanup);

  it("limits visible grid opacity to 5–100%, including the numeric control", () => {
    render(<GridOpacitySettings onError={vi.fn()} />);
    expect(screen.getByRole("slider").getAttribute("min")).toBe("5");
    expect(screen.getByRole("slider").getAttribute("max")).toBe("100");
    expect(document.querySelector("input[type=number]")?.getAttribute("min")).toBe("5");
  });

  it("represents the deliberate 0% eye state without losing the minimum on restoration", () => {
    state.opacity = 0;
    const view = render(<GridOpacitySettings onError={vi.fn()} />);
    expect(screen.getByRole("slider").getAttribute("min")).toBe("0");
    expect(screen.getByRole("slider").getAttribute("value")).toBe("0");
    state.opacity = 47;
    view.rerender(<GridOpacitySettings onError={vi.fn()} />);
    expect(screen.getByRole("slider").getAttribute("min")).toBe("5");
    expect(screen.getByRole("slider").getAttribute("value")).toBe("47");
  });

  it("clamps typed zero to 5% rather than hiding a visible grid", async () => {
    render(<GridOpacitySettings onError={vi.fn()} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ preview_grid: { opacity: 5 } }));
  });
});
