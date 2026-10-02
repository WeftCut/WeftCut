// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FontSelect } from "./FontSelect";
import { DEFAULT_CAPTION_FONT_FAMILY } from "../../shared/fonts";
const { getFamilies } = vi.hoisted(() => ({ getFamilies: vi.fn() }));
(window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;
vi.mock("./fontFamilies", () => ({ getSystemFontFamilies: getFamilies }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("FontSelect", () => {
  it("preserves an unavailable current family while installed names load", async () => {
    let resolve!: (names: string[]) => void;
    getFamilies.mockReturnValue(new Promise<string[]>((done) => { resolve = done; }));
    const onValueChange = vi.fn();
    render(<FontSelect value="Missing Family" onValueChange={onValueChange} ariaLabel="Font" />);
    expect(screen.getByRole("combobox").textContent).toContain("Missing Family");
    resolve(["Example Sans", "Liberation Sans"]);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    fireEvent.click(screen.getByRole("combobox"));
    await screen.findByRole("option", { name: "Example Sans" });
    expect(screen.getAllByRole("option", { name: "Liberation Sans" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("option", { name: "Example Sans" }));
    expect(onValueChange).toHaveBeenCalledWith("Example Sans");
  });

  it("labels the bundled chain and supports clearing a settings preference", async () => {
    getFamilies.mockResolvedValue([]);
    const onValueChange = vi.fn();
    const { rerender } = render(<FontSelect value={DEFAULT_CAPTION_FONT_FAMILY} onValueChange={onValueChange} ariaLabel="Font" />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByRole("combobox").textContent).toContain("fonts.app_default");
    rerender(<FontSelect value="Liberation Sans" defaultValue="" onValueChange={onValueChange} ariaLabel="Font" />);
    fireEvent.click(screen.getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "fonts.app_default" }));
    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it("keeps bundled choices available on failure and retries", async () => {
    getFamilies.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(["Recovered Sans"]);
    render(<FontSelect value={DEFAULT_CAPTION_FONT_FAMILY} onValueChange={vi.fn()} ariaLabel="Font" />);
    await screen.findByRole("alert");
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "fonts.retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(getFamilies).toHaveBeenCalledTimes(2);
  });
});
